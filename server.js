const http = require("http");
const { randomUUID, randomBytes, scryptSync, timingSafeEqual, createHash, createHmac } = require("crypto");
const { Pool } = require("pg");

const PORT = process.env.PORT || 3000;
const MP_API = "https://api.mercadopago.com";
const FRONTEND_URL = (process.env.FRONTEND_URL || "").replace(/\/+$/, "");
const dbPool = process.env.DATABASE_URL ? new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  ssl: process.env.DATABASE_URL.includes(".render.com") ? { rejectUnauthorized: false } : false
}) : null;

// Esquema inicial idempotente. La falta de DB no detiene el servidor de pagos.
async function initializeDatabase() {
  if (!dbPool) return console.warn("DATABASE_URL no configurada.");
  await dbPool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id BIGSERIAL PRIMARY KEY, order_number VARCHAR(30) UNIQUE,
      source VARCHAR(20) NOT NULL DEFAULT 'online', external_payment_id VARCHAR(100),
      customer_name VARCHAR(120), customer_phone VARCHAR(30), customer_email VARCHAR(254),
      delivery_address TEXT, locality VARCHAR(80), delivery_method VARCHAR(30),
      total_clp INTEGER NOT NULL DEFAULT 0, payment_status VARCHAR(30) NOT NULL DEFAULT 'pending',
      delivery_status VARCHAR(30) NOT NULL DEFAULT 'pending',
      items_json JSONB NOT NULL DEFAULT '[]'::jsonb, notes TEXT, delivery_fee_clp INTEGER NOT NULL DEFAULT 0, external_reference VARCHAR(100), driver_fee_clp INTEGER NOT NULL DEFAULT 2000, delivery_zone VARCHAR(20) NOT NULL DEFAULT 'normal',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS items_json JSONB NOT NULL DEFAULT '[]'::jsonb;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS notes TEXT;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_fee_clp INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS external_reference VARCHAR(100);
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS driver_fee_clp INTEGER NOT NULL DEFAULT 2000;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_zone VARCHAR(20) NOT NULL DEFAULT 'normal';
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_latitude DOUBLE PRECISION;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_longitude DOUBLE PRECISION;
    CREATE TABLE IF NOT EXISTS app_users (
      id BIGSERIAL PRIMARY KEY,
      username VARCHAR(80) UNIQUE NOT NULL,
      full_name VARCHAR(120) NOT NULL,
      role VARCHAR(20) NOT NULL DEFAULT 'driver',
      password_salt TEXT,
      password_hash TEXT,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE app_users DROP CONSTRAINT IF EXISTS app_users_role_check;
    ALTER TABLE app_users ADD CONSTRAINT app_users_role_check CHECK (role IN ('superadmin','manager','driver'));
    ALTER TABLE app_users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT TRUE;
    INSERT INTO app_users (username, full_name, role) VALUES
      ('jefa', 'Michelle Ibáñez', 'manager'),
      ('maximo', 'Máximo Palma', 'superadmin'),
      ('claudio', 'Claudio Scheid', 'driver')
    ON CONFLICT (username) DO UPDATE SET full_name = EXCLUDED.full_name;
    UPDATE app_users SET role='superadmin' WHERE username='maximo';
    UPDATE app_users SET role='manager' WHERE username='jefa';
    UPDATE app_users SET role='driver' WHERE username='claudio';
    CREATE TABLE IF NOT EXISTS app_sessions (
      token_hash TEXT PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS drivers (
      id BIGSERIAL PRIMARY KEY, display_name VARCHAR(120) NOT NULL,
      username VARCHAR(80) UNIQUE NOT NULL, password_hash TEXT NOT NULL,
      active BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE drivers ADD COLUMN IF NOT EXISTS app_user_id BIGINT REFERENCES app_users(id);
    INSERT INTO drivers (display_name,username,password_hash) VALUES
      ('Máximo Palma','maximo','DISABLED_USE_APP_USERS_AUTH'),
      ('Claudio Scheid','claudio','DISABLED_USE_APP_USERS_AUTH')
    ON CONFLICT (username) DO UPDATE SET display_name=EXCLUDED.display_name;
    UPDATE drivers d SET app_user_id=u.id FROM app_users u WHERE d.username=u.username AND d.app_user_id IS NULL;
    CREATE TABLE IF NOT EXISTS delivery_assignments (
      id BIGSERIAL PRIMARY KEY, order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      driver_id BIGINT NOT NULL REFERENCES drivers(id), assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      status VARCHAR(30) NOT NULL DEFAULT 'assigned'
    );
    CREATE TABLE IF NOT EXISTS extra_runs (
      id BIGSERIAL PRIMARY KEY, driver_id BIGINT NOT NULL REFERENCES drivers(id),
      description TEXT NOT NULL, destination TEXT, requested_amount_clp INTEGER NOT NULL DEFAULT 0,
      approved_amount_clp INTEGER, approval_status VARCHAR(20) NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), approved_at TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS shift_closings (
      id BIGSERIAL PRIMARY KEY, driver_id BIGINT NOT NULL REFERENCES drivers(id),
      shift_date DATE NOT NULL DEFAULT CURRENT_DATE, delivery_total_clp INTEGER NOT NULL DEFAULT 0,
      extra_total_clp INTEGER NOT NULL DEFAULT 0, grand_total_clp INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at);
    CREATE INDEX IF NOT EXISTS idx_orders_delivery_status ON orders(delivery_status);
    CREATE INDEX IF NOT EXISTS idx_assignments_driver ON delivery_assignments(driver_id);
    CREATE INDEX IF NOT EXISTS idx_extra_runs_driver ON extra_runs(driver_id);
  `);
  await dbPool.query("DELETE FROM app_sessions WHERE expires_at < NOW()");
  const tempPassword = process.env.INITIAL_TEMP_PASSWORD;
  if (tempPassword) {
    for (const username of ["jefa", "maximo", "claudio"]) {
      const row = await dbPool.query("SELECT password_hash FROM app_users WHERE username=$1", [username]);
      if (row.rows[0] && !row.rows[0].password_hash) {
        const salt = randomBytes(16).toString("hex");
        const hash = scryptSync(tempPassword, salt, 64).toString("hex");
        await dbPool.query("UPDATE app_users SET password_salt=$1,password_hash=$2 WHERE username=$3", [salt, hash, username]);
      }
    }
  }
  console.log("PostgreSQL conectado; esquema inicial verificado.");
}


const deliveryFees = { "Linares":1990, "Longaví":3500, "Yerbas Buenas":3000, "Colbún":12000, "Villa Alegre":4000, "San Javier":5000, "Palmilla":5000 };

const products = {
  "California Rolls": 4700, "Tempura o Panko": 4900, "Salmón": 5500,
  "Avocado": 4900, "Hosomaki": 2350, "Chicken (10 cortes)": 5390,
  "Fresh (10 cortes)": 4990, "Mechada Rolls (10 cortes)": 5490,
"Tor Rolls (10 cortes)": 5550,
"Nigiri (2 bocados)": 3300,
"Sashimi 6 cortes": 5200, "Sashimi 9 cortes": 6900,
  "Ceviche camarón-salmón": 7990, "Ceviche mixto": 9490, "Gohan a elección": 5990,
  "Napolitana": 7990, "Pollo champiñón": 8990, "Cuatro estaciones": 8990,
  "Peperoni": 7990, "Especial carne": 8990, "Mexicana": 8990,
  "Mediterránea": 9990, "Mechada choclo": 8990, "Carnes mixtas": 8990,
  "Clásico de la casa": 4990, "Chacarero": 4990, "Barros Luco": 4990,
  "Benjita": 6490, "Sándwich del chef": 5990, "A lo pobre": 5990,
  "Vegetariano": 6490, "Mexicano": 5990, "Chileno": 5990,
  "Cheese Cream": 6890, "Chicken": 6990,
  "Bebida lata 350 cc": 1500, "Bebida botella 1,5 litros": 2500,
  "Jugo natural 350 cc": 2500, "Jugo natural 1 litro": 3990,
  "Néctar 1,5 litros": 2500, "Agua mineral 600 ml": 1000,
  "Red Bull 250 cc": 2500
};

function isOrderingOpen(){
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Santiago", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  const days = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  let day = days[values.weekday];
  const hour = Number(values.hour);
  const minute = Number(values.minute);
  if (hour < 2) day = (day + 6) % 7;
  return day >= 2 && day <= 6 && (hour < 2 || hour > 17 || (hour === 17 && minute >= 30));
}

function send(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY"
  });
  res.end(JSON.stringify(body));
}

// Límite básico por IP para reducir consultas automatizadas.
// Se usa la IP de la conexión directa y no cabeceras reenviadas por el cliente.
const requestBuckets = new Map();
function isRateLimited(req, limit, windowMs) {
  const ip = req.socket.remoteAddress || "unknown";
  const now = Date.now();
  let bucket = requestBuckets.get(ip);
  if (!bucket || now - bucket.startedAt >= windowMs) {
    bucket = { startedAt: now, count: 0 };
    requestBuckets.set(ip, bucket);
  }
  bucket.count += 1;
  if (requestBuckets.size > 5000) {
    for (const [key, value] of requestBuckets) {
      if (now - value.startedAt >= windowMs) requestBuckets.delete(key);
    }
  }
  return bucket.count > limit;
}

async function readJson(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 50000) throw new Error("Pedido demasiado grande");
  }
  return JSON.parse(raw || "{}");
}

async function mpRequest(path, options = {}) {
  const token = process.env.MP_ACCESS_TOKEN;
  if (!token) throw new Error("Falta configurar MP_ACCESS_TOKEN en Render");
  return fetch(`${MP_API}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`,
      ...(options.headers || {})
    }
  });
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  if (origin && FRONTEND_URL && origin === new URL(FRONTEND_URL).origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Credentials", "true");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  const requestPath = new URL(req.url, "http://localhost").pathname;


  // Autenticación de personal: sesión aleatoria en cookie HttpOnly y contraseña scrypt.
  if (req.method === "POST" && requestPath === "/api/personal/login") {
    if (!dbPool) return send(res, 503, { error: "Base de datos no disponible." });
    if (isRateLimited(req, 8, 60000)) return send(res, 429, { error: "Demasiados intentos. Espera un minuto." });
    try {
      const data = await readJson(req);
      const username = String(data.username || "").trim().toLowerCase();
      const password = String(data.password || "");
      const found = await dbPool.query("SELECT id,username,full_name,role,password_salt,password_hash,active FROM app_users WHERE username=$1", [username]);
      const user = found.rows[0];
      if (!user || !user.active || !user.password_hash || !user.password_salt) return send(res, 401, { error: "Usuario o contraseña incorrectos." });
      const candidate = scryptSync(password, user.password_salt, 64);
      const expected = Buffer.from(user.password_hash, "hex");
      if (candidate.length !== expected.length || !timingSafeEqual(candidate, expected)) return send(res, 401, { error: "Usuario o contraseña incorrectos." });
      const token = randomBytes(32).toString("hex");
      const tokenHash = createHash("sha256").update(token).digest("hex");
      await dbPool.query("INSERT INTO app_sessions(token_hash,user_id,expires_at) VALUES($1,$2,NOW()+INTERVAL '12 hours')", [tokenHash,user.id]);
      res.setHeader("Set-Cookie", "pb_session="+token+"; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=43200");
      return send(res, 200, { user: { username:user.username, full_name:user.full_name, role:user.role }, mustChangePassword: user.must_change_password });
    } catch (error) { console.error("Login error:", error.message); return send(res, 400, { error: "No fue posible iniciar sesión." }); }
  }

  if (requestPath.startsWith("/api/personal/usuarios")) {
    const actor = await getStaffUser();
    if (!isSuperAdmin(actor)) return send(res,403,{error:"Solo el administrador TI puede administrar usuarios."});
    if (req.method === "GET" && requestPath === "/api/personal/usuarios") {
      const users = await dbPool.query("SELECT username,full_name,role,active,created_at FROM app_users ORDER BY created_at");
      return send(res,200,{users:users.rows});
    }
    if (req.method === "POST" && requestPath === "/api/personal/usuarios") {
      try {
        const d=await readJson(req), username=String(d.username||"").trim().toLowerCase(), fullName=String(d.full_name||"").trim(), role=String(d.role||"");
        if(!/^[a-z0-9._-]{3,40}$/.test(username)||!fullName||fullName.length>120||!["manager","driver"].includes(role)) return send(res,400,{error:"Datos inválidos. Usuario de 3 a 40 caracteres y rol permitido."});
        const saved=await dbPool.query("INSERT INTO app_users(username,full_name,role) VALUES($1,$2,$3) RETURNING username,full_name,role,active",[username,fullName,role]);
        if(role==="driver"){
          await dbPool.query("INSERT INTO drivers(display_name,username,password_hash,app_user_id) VALUES($1,$2,'DISABLED_USE_APP_USERS_AUTH',$3)",[fullName,username,(await dbPool.query("SELECT id FROM app_users WHERE username=$1",[username])).rows[0].id]);
        }
        return send(res,201,{user:saved.rows[0],message:"Usuario creado. Debe establecer su contraseña en el primer acceso."});
      } catch(e) { return send(res,409,{error:"No se pudo crear el usuario. Puede que el nombre ya exista."}); }
    }
    if (req.method === "POST" && requestPath === "/api/personal/usuarios/clave") {
      try {
        const d=await readJson(req), username=String(d.username||"").trim().toLowerCase(), password=String(d.password||"");
        if(!username||password.length<10) return send(res,400,{error:"La contraseña debe tener al menos 10 caracteres."});
        const salt=randomBytes(16).toString("hex"), hash=scryptSync(password,salt,64).toString("hex");
        const updated=await dbPool.query("UPDATE app_users SET password_salt=$1,password_hash=$2,must_change_password=TRUE WHERE username=$3 AND username<>'maximo' RETURNING username",[salt,hash,username]);
        if(!updated.rowCount) return send(res,404,{error:"Usuario no encontrado o no se permite restablecer la cuenta principal desde esta opción."});
        await dbPool.query("DELETE FROM app_sessions WHERE user_id=(SELECT id FROM app_users WHERE username=$1)",[username]);
        return send(res,200,{ok:true,message:"Contraseña restablecida; deberá cambiarla al ingresar."});
      } catch(e) { return send(res,400,{error:"No se pudo restablecer la contraseña."}); }
    }
    if (req.method === "POST" && requestPath === "/api/personal/usuarios/estado") {
      try {
        const d=await readJson(req), username=String(d.username||"").trim().toLowerCase(), active=d.active===true;
        if(!username||username==="maximo") return send(res,400,{error:"No puedes desactivar la cuenta principal."});
        const updated=await dbPool.query("UPDATE app_users SET active=$1 WHERE username=$2 RETURNING id",[active,username]);
        if(!updated.rowCount) return send(res,404,{error:"Usuario no encontrado."});
        if(!active) await dbPool.query("DELETE FROM app_sessions WHERE user_id=$1",[updated.rows[0].id]);
        return send(res,200,{ok:true});
      } catch(e) { return send(res,400,{error:"No se pudo cambiar el estado del usuario."}); }
    }
  }

  if (req.method === "POST" && requestPath === "/api/personal/logout") {
    const token = (req.headers.cookie || "").split(";").map(x=>x.trim()).find(x=>x.startsWith("pb_session="))?.slice(11);
    if (token && dbPool) await dbPool.query("DELETE FROM app_sessions WHERE token_hash=$1", [createHash("sha256").update(token).digest("hex")]);
    res.setHeader("Set-Cookie", "pb_session=; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=0");
    return send(res, 200, { ok:true });
  }

  if (req.method === "GET" && requestPath === "/api/personal/me") {
    const token = (req.headers.cookie || "").split(";").map(x=>x.trim()).find(x=>x.startsWith("pb_session="))?.slice(11);
    if (!token || !dbPool) return send(res, 401, { error:"Sesión no válida." });
    const found = await dbPool.query("SELECT u.username,u.full_name,u.role FROM app_sessions s JOIN app_users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>NOW() AND u.active=TRUE", [createHash("sha256").update(token).digest("hex")]);
    if (!found.rowCount) return send(res, 401, { error:"Sesión vencida." });
    return send(res, 200, { user:found.rows[0] });
  }

  if (req.method === "POST" && requestPath === "/api/personal/cambiar-clave") {
    const token = (req.headers.cookie || "").split(";").map(x=>x.trim()).find(x=>x.startsWith("pb_session="))?.slice(11);
    if (!token || !dbPool) return send(res, 401, { error:"Inicia sesión nuevamente." });
    try {
      const data = await readJson(req);
      const password = String(data.password || "");
      if (password.length < 10) return send(res, 400, { error:"La nueva clave debe tener al menos 10 caracteres." });
      const session = await dbPool.query("SELECT user_id FROM app_sessions WHERE token_hash=$1 AND expires_at>NOW()", [createHash("sha256").update(token).digest("hex")]);
      if (!session.rowCount) return send(res, 401, { error:"Sesión vencida." });
      const salt = randomBytes(16).toString("hex");
      const hash = scryptSync(password, salt, 64).toString("hex");
      await dbPool.query("UPDATE app_users SET password_salt=$1,password_hash=$2,must_change_password=FALSE WHERE id=$3", [salt,hash,session.rows[0].user_id]);
      return send(res, 200, { ok:true, message:"Contraseña actualizada." });
    } catch (error) { console.error("Password update error:",error.message); return send(res,400,{error:"No fue posible cambiar la contraseña."}); }
  }


  async function getStaffUser() {
    const token = (req.headers.cookie || "").split(";").map(x=>x.trim()).find(x=>x.startsWith("pb_session="))?.slice(11);
    if (!token || !dbPool) return null;
    const result = await dbPool.query("SELECT u.id,u.username,u.full_name,u.role FROM app_sessions s JOIN app_users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>NOW() AND u.active=TRUE", [createHash("sha256").update(token).digest("hex")]);
    return result.rows[0] || null;
  }
  function isSuperAdmin(staff) { return Boolean(staff && staff.role === "superadmin"); }
  function canManageOrders(staff) { return Boolean(staff && ["superadmin","manager"].includes(staff.role)); }
  if (req.method === "GET" && requestPath === "/api/personal/test-mode") {
    const staff = await getStaffUser();
    return send(res, 200, { allowed: isSuperAdmin(staff) });
  }

  if (requestPath.startsWith("/api/reparto/")) {
    if (!dbPool) return send(res,503,{error:"Base de datos no disponible."});
    const staff = await getStaffUser();
    if (!staff) return send(res,401,{error:"Inicia sesión para continuar."});
    if (requestPath === "/api/reparto/pedidos" && req.method === "GET") {
      const params = [];
      if (staff.role === "driver") params.push(staff.id);
      const result = await dbPool.query(
        "SELECT o.id,o.order_number,o.customer_name,o.customer_phone,o.delivery_address,o.locality,o.delivery_latitude,o.delivery_longitude,o.delivery_method,o.total_clp,o.payment_status,o.delivery_status,o.created_at,a.id AS assignment_id,a.status AS assignment_status,d.display_name AS driver_name FROM orders o LEFT JOIN LATERAL (SELECT da.* FROM delivery_assignments da WHERE da.order_id=o.id ORDER BY da.assigned_at DESC LIMIT 1) a ON TRUE LEFT JOIN drivers d ON d.id=a.driver_id WHERE LOWER(COALESCE(o.payment_status,'')) IN ('approved','paid') AND LOWER(COALESCE(o.delivery_method,'')) IN ('delivery','despacho') " +
        (staff.role === "driver" ? "AND d.app_user_id=$1 " : "") +
        "ORDER BY o.created_at DESC LIMIT 200", params);
      return send(res,200,{orders:result.rows,role:staff.role});
    }
    if (requestPath === "/api/reparto/asignar-lote" && req.method === "POST") {
      if (!canManageOrders(staff)) return send(res,403,{error:"No tienes permisos para asignar pedidos."});
      try {
        const data=await readJson(req), ids=[...new Set((Array.isArray(data.order_ids)?data.order_ids:[]).map(Number).filter(n=>Number.isInteger(n)&&n>0))], username=String(data.driver_username||"");
        if(!ids.length||ids.length>100||!["maximo","claudio"].includes(username)) return send(res,400,{error:"Selecciona pedidos y un repartidor válido."});
        const driver=await dbPool.query("SELECT id FROM drivers WHERE username=$1 AND active=TRUE",[username]);
        if(!driver.rowCount) return send(res,404,{error:"Repartidor no encontrado."});
        const client=await dbPool.connect();
        try {
          await client.query("BEGIN");
          const eligible=await client.query("SELECT o.id FROM orders o WHERE o.id=ANY($1::int[]) AND o.payment_status IN ('approved','paid') AND o.delivery_method IN ('Delivery','delivery','despacho') AND NOT EXISTS (SELECT 1 FROM delivery_assignments da WHERE da.order_id=o.id AND da.status IN ('assigned','picked_up')) FOR UPDATE",[ids]);
          if(eligible.rowCount!==ids.length) throw new Error("Uno o más pedidos ya fueron asignados, no están pagados o no son delivery. Actualiza la lista.");
          for(const id of ids){
            await client.query("UPDATE delivery_assignments SET status='reassigned' WHERE order_id=$1 AND status IN ('assigned','picked_up')",[id]);
            await client.query("INSERT INTO delivery_assignments(order_id,driver_id,status) VALUES($1,$2,'assigned')",[id,driver.rows[0].id]);
            await client.query("UPDATE orders SET delivery_status='assigned',updated_at=NOW() WHERE id=$1",[id]);
          }
          await client.query("COMMIT");
        } catch(e) { await client.query("ROLLBACK"); throw e; } finally { client.release(); }
        return send(res,200,{ok:true,assigned:ids.length});
      } catch(e) { return send(res,409,{error:e.message||"No se pudieron asignar los pedidos."}); }
    }
    if (requestPath === "/api/reparto/asignar" && req.method === "POST") {
      if (!canManageOrders(staff)) return send(res,403,{error:"No tienes permisos para asignar pedidos."});
      try {
        const data=await readJson(req), orderId=Number(data.order_id), username=String(data.driver_username||"");
        if(!Number.isInteger(orderId)||orderId<1||!["maximo","claudio"].includes(username)) return send(res,400,{error:"Pedido o repartidor inválido."});
        const eligible=await dbPool.query("SELECT o.id FROM orders o WHERE o.id=$1 AND LOWER(COALESCE(o.payment_status,'')) IN ('approved','paid') AND LOWER(COALESCE(o.delivery_method,'')) IN ('delivery','despacho') AND NOT EXISTS (SELECT 1 FROM delivery_assignments da WHERE da.order_id=o.id AND da.status IN ('assigned','picked_up'))",[orderId]);
        if(!eligible.rowCount) return send(res,409,{error:"El pedido ya fue asignado o no está pagado y listo para delivery."});
        const driver=await dbPool.query("SELECT id FROM drivers WHERE username=$1 AND active=TRUE",[username]);
        if(!driver.rowCount) return send(res,404,{error:"Repartidor no encontrado."});
        const client=await dbPool.connect();
        try {
          await client.query("BEGIN");
          await client.query("UPDATE delivery_assignments SET status='reassigned' WHERE order_id=$1 AND status IN ('assigned','picked_up')",[orderId]);
          await client.query("INSERT INTO delivery_assignments(order_id,driver_id,status) VALUES($1,$2,'assigned')",[orderId,driver.rows[0].id]);
          await client.query("UPDATE orders SET delivery_status='assigned',updated_at=NOW() WHERE id=$1",[orderId]);
          await client.query("COMMIT");
        } catch(e) { await client.query("ROLLBACK"); throw e; } finally { client.release(); }
        return send(res,200,{ok:true});
      } catch(e) { return send(res,400,{error:"No se pudo asignar el pedido."}); }
    }

    if (requestPath === "/api/reparto/orden-manual" && req.method === "POST") {
      if (!isSuperAdmin(staff)) return send(res,403,{error:"Solo el administrador TI puede registrar pedidos manuales."});
      try {
        const d=await readJson(req);
        const name=String(d.customer_name||"").trim(), phone=String(d.customer_phone||"").trim();
        const address=String(d.delivery_address||"").trim(), locality=String(d.locality||"").trim();
        const method=String(d.delivery_method||"Delivery");
        const total=Number(d.total_clp), zone=d.delivery_zone==="far"?"far":"normal";
        const source=["cash","whatsapp","in_person"].includes(d.source)?d.source:"cash";
        if(!name||!Number.isInteger(total)||total<0||total>1000000||!["Delivery","Retiro en el local"].includes(method)) return send(res,400,{error:"Datos de pedido inválidos."});
        if(method==="Delivery"&&(!address||!locality)) return send(res,400,{error:"Falta dirección o localidad."});
        const driverFee=method==="Delivery"?(zone==="far"?3000:2000):0;
        const items=Array.isArray(d.items)?d.items:[];
        const saved=await dbPool.query(
          "INSERT INTO orders(source,customer_name,customer_phone,delivery_address,locality,delivery_method,total_clp,payment_status,delivery_status,items_json,notes,driver_fee_clp,delivery_zone,delivery_latitude,delivery_longitude) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'pending',$9::jsonb,$10,$11,$12) RETURNING id",
          [source,name,phone||null,address||null,locality||null,method,total,d.payment_status==="paid"?"paid":"pending",JSON.stringify(items),String(d.notes||""),driverFee,zone,d.latitude!==null&&d.latitude!==undefined&&d.latitude!==""&&Number.isFinite(Number(d.latitude))?Number(d.latitude):null,d.longitude!==null&&d.longitude!==undefined&&d.longitude!==""&&Number.isFinite(Number(d.longitude))?Number(d.longitude):null]
        );
        const id=saved.rows[0].id, number="PB-"+String(id).padStart(6,"0");
        await dbPool.query("UPDATE orders SET order_number=$1 WHERE id=$2",[number,id]);
        return send(res,201,{ok:true,order_number:number,driver_fee_clp:driverFee});
      } catch(e) { console.error("Manual order:",e.message); return send(res,400,{error:"No se pudo registrar el pedido."}); }
    }
    if (requestPath === "/api/reparto/extras" && req.method === "GET") {
      const q=["superadmin","manager"].includes(staff.role)
        ? await dbPool.query("SELECT e.id,e.description,e.destination,e.requested_amount_clp,e.approved_amount_clp,e.approval_status,e.created_at,d.display_name AS driver_name FROM extra_runs e JOIN drivers d ON d.id=e.driver_id ORDER BY e.created_at DESC LIMIT 200")
        : await dbPool.query("SELECT e.id,e.description,e.destination,e.requested_amount_clp,e.approved_amount_clp,e.approval_status,e.created_at,d.display_name AS driver_name FROM extra_runs e JOIN drivers d ON d.id=e.driver_id WHERE d.app_user_id=$1 ORDER BY e.created_at DESC LIMIT 100",[staff.id]);
      return send(res,200,{extras:q.rows});
    }
    if (requestPath === "/api/reparto/extras" && req.method === "POST") {
      if(!["driver","superadmin"].includes(staff.role)) return send(res,403,{error:"Solo repartidores pueden solicitar carreras extra."});
      try {
        const d=await readJson(req), description=String(d.description||"").trim(), destination=String(d.destination||"").trim(), amount=Number(d.amount);
        if(!description||!Number.isInteger(amount)||amount<0||amount>200000) return send(res,400,{error:"Descripción o monto inválido."});
        const driver=await dbPool.query("SELECT id FROM drivers WHERE app_user_id=$1 AND active=TRUE",[staff.id]);
        if(!driver.rowCount) return send(res,404,{error:"Perfil de repartidor no configurado."});
        const saved=await dbPool.query("INSERT INTO extra_runs(driver_id,description,destination,requested_amount_clp) VALUES($1,$2,$3,$4) RETURNING id",[driver.rows[0].id,description,destination,amount]);
        return send(res,201,{ok:true,id:saved.rows[0].id,approval_status:"pending"});
      } catch(e) { return send(res,400,{error:"No se pudo registrar la carrera extra."}); }
    }
    if (requestPath === "/api/reparto/extras/aprobar" && req.method === "POST") {
      if(staff.role!=="manager") return send(res,403,{error:"Solo el perfil de jefatura puede aprobar o rechazar carreras extra."});
      try {
        const d=await readJson(req), id=Number(d.id), approved=d.approved===true, amount=Number(d.amount);
        if(!Number.isInteger(id)||id<1||(approved&&(!Number.isInteger(amount)||amount<0||amount>200000))) return send(res,400,{error:"Datos de aprobación inválidos."});
        const result=await dbPool.query("UPDATE extra_runs SET approval_status=$1,approved_amount_clp=$2,approved_at=NOW() WHERE id=$3 AND approval_status='pending' RETURNING id", [approved?"approved":"rejected",approved?amount:null,id]);
        if(!result.rowCount) return send(res,404,{error:"Carrera no encontrada o ya revisada."});
        return send(res,200,{ok:true});
      } catch(e) { return send(res,400,{error:"No se pudo revisar la carrera."}); }
    }
    if (requestPath === "/api/reparto/cierre" && req.method === "GET") {
      const driverId=["driver","superadmin"].includes(staff.role)?(await dbPool.query("SELECT id FROM drivers WHERE app_user_id=$1",[staff.id])).rows[0]?.id:null;
      if(["driver","superadmin"].includes(staff.role)&&!driverId) return send(res,404,{error:"Perfil de repartidor no configurado."});
      const params=driverId?[driverId]:[];
      const where=driverId?"AND da.driver_id=$1":"";
      const deliveries=await dbPool.query(
        "SELECT o.order_number,o.created_at,o.delivery_address,o.locality,o.driver_fee_clp,o.delivery_zone,o.delivery_status,d.display_name AS driver_name FROM delivery_assignments da JOIN orders o ON o.id=da.order_id JOIN drivers d ON d.id=da.driver_id WHERE da.status='delivered' "+where+" ORDER BY o.created_at DESC LIMIT 500",params);
      const extras=await dbPool.query(
        "SELECT e.description,e.destination,e.requested_amount_clp,e.approved_amount_clp,e.approval_status,e.created_at,d.display_name AS driver_name FROM extra_runs e JOIN drivers d ON d.id=e.driver_id WHERE e.approval_status='approved' "+(driverId?"AND e.driver_id=$1 ":"")+"ORDER BY e.created_at DESC LIMIT 500",params);
      const totals=await dbPool.query(
        "SELECT d.display_name,COALESCE(SUM(o.driver_fee_clp),0)::int AS delivery_total FROM delivery_assignments da JOIN orders o ON o.id=da.order_id JOIN drivers d ON d.id=da.driver_id WHERE da.status='delivered' "+where+" GROUP BY d.id,d.display_name",params);
      return send(res,200,{deliveries:deliveries.rows,extras:extras.rows,totals:totals.rows});
    }
    if (requestPath === "/api/reparto/estado" && req.method === "POST") {
      try {
        const data=await readJson(req), orderId=Number(data.order_id), status=String(data.status||"");
        if(!Number.isInteger(orderId)||!["picked_up","delivered"].includes(status)) return send(res,400,{error:"Estado inválido."});
        const assignment=await dbPool.query("SELECT da.id FROM delivery_assignments da JOIN drivers d ON d.id=da.driver_id WHERE da.order_id=$1 AND da.status IN ('assigned','picked_up') AND ($2='superadmin' OR d.app_user_id=$3) ORDER BY da.assigned_at DESC LIMIT 1",[orderId,staff.role,staff.id]);
        if(!assignment.rowCount) return send(res,404,{error:"Pedido no asignado a tu cuenta."});
        await dbPool.query("UPDATE delivery_assignments SET status=$1 WHERE id=$2",[status,assignment.rows[0].id]);
        await dbPool.query("UPDATE orders SET delivery_status=$1,updated_at=NOW() WHERE id=$2",[status,orderId]);
        return send(res,200,{ok:true});
      } catch(e) { return send(res,400,{error:"No se pudo actualizar el pedido."}); }
    }
  }


  if (req.method === "POST" && requestPath === "/api/mercadopago/webhook") {
    try {
      const secret = process.env.MP_WEBHOOK_SECRET;
      if (!secret) return send(res, 503, { error: "Webhook secret not configured." });

      const url = new URL(req.url, "http://localhost");
      const data = await readJson(req);
      // Mercado Pago documents data.id in the query string; body fallback helps
      // with compatible test senders. Preserve the original value for HMAC.
      const id = String(url.searchParams.get("data.id") || data?.data?.id || "");
      const signature = String(req.headers["x-signature"] || "");
      const requestId = String(req.headers["x-request-id"] || "");
      const ts = signature.match(/(?:^|,)\s*ts=([^,]+)/)?.[1];
      const v1 = signature.match(/(?:^|,)\s*v1=([^,]+)/)?.[1];

      if (!id || !ts || !v1 || !requestId) {
        return send(res, 401, { error: "Invalid webhook signature." });
      }

      // Reject stale signatures (5-minute tolerance) to reduce replay risk.
      const timestampMs = Number(ts) * 1000;
      if (!Number.isFinite(timestampMs) || Math.abs(Date.now() - timestampMs) > 5 * 60 * 1000) {
        return send(res, 401, { error: "Expired webhook signature." });
      }

      const manifest = "id:" + id + ";request-id:" + requestId + ";ts:" + ts + ";";
      const expected = createHmac("sha256", secret).update(manifest).digest("hex");
      const a = Buffer.from(expected, "hex");
      const b = Buffer.from(v1, "hex");
      if (a.length !== b.length || !timingSafeEqual(a, b)) {
        return send(res, 401, { error: "Invalid webhook signature." });
      }

      // The simulator can send a synthetic Data ID that is not a real Order.
      // A validly signed event is acknowledged even when that resource is absent.
      const response = await mpRequest("/v1/orders/" + encodeURIComponent(id));
      const order = await response.json();
      if (response.status === 404) {
        console.log("MP webhook validado; recurso de prueba no encontrado:", id);
        return send(res, 200, { received: true, resource_found: false });
      }
      if (!response.ok) {
        console.error("MP webhook: consulta de orden fallida", response.status);
        return send(res, 502, { error: "Could not verify order with Mercado Pago." });
      }

      const paid = Number(order.total_paid_amount || 0);
      const total = Number(order.total_amount || 0);
      const approved = order.status === "processed" && total > 0 && paid >= total;
      if (dbPool) {
        await dbPool.query(
          "UPDATE orders SET payment_status=$1,updated_at=NOW() WHERE external_payment_id=$2",
          [approved ? "approved" : String(order.status || "pending"), id]
        );
      }
      return send(res, 200, { received: true, resource_found: true });
    } catch (e) {
      console.error("MP webhook:", e.message);
      return send(res, 400, { error: "Webhook processing failed." });
    }
  }

  if (req.method === "GET" && requestPath === "/api/salud-db") {
    if (!dbPool) return send(res, 503, { database: "not_configured" });
    try {
      await dbPool.query("SELECT 1");
      return send(res, 200, { database: "connected" });
    } catch (error) {
      console.error("PostgreSQL health check failed:", error.message);
      return send(res, 503, { database: "unavailable" });
    }
  }

  if (req.method === "GET" && req.url === "/") {
    return send(res, 200, { status: "Servidor activo", ordering_open: isOrderingOpen(), hours: "Martes a sábado, 17:30 a 02:00 (America/Santiago)" });
  }

  // Consultar la orden directamente en Mercado Pago; nunca confiar en el estado de la URL.
  const orderMatch = req.method === "GET" && req.url.match(/^\/api\/orden\/([A-Za-z0-9_-]+)$/);
  if (orderMatch) {
    if (isRateLimited(req, 20, 60_000)) {
      return send(res, 429, { error: "Demasiadas consultas. Espera un minuto e inténtalo nuevamente." });
    }
    try {
      const orderId = orderMatch[1];
      const response = await mpRequest(`/v1/orders/${encodeURIComponent(orderId)}`);
      const order = await response.json();
      if (!response.ok) {
        console.error("Error consultando orden:", order);
        return send(res, response.status, { error: "No se pudo verificar el pago en Mercado Pago." });
      }

      const paid = Number(order.total_paid_amount || 0);
      const total = Number(order.total_amount || 0);
      const approved = order.status === "processed" && total > 0 && paid >= total;
      if (dbPool) {
        await dbPool.query(
          "UPDATE orders SET payment_status=$1,updated_at=NOW() WHERE external_payment_id=$2",
          [approved ? "approved" : String(order.status || "pending"), orderId]
        );
      }

      // Nunca devolver dirección, teléfono ni otros datos personales al navegador.
      const delivery = Boolean(order.payer?.address || order.shipment?.address);

      return send(res, 200, {
        approved,
        status: order.status || "unknown",
        status_detail: order.status_detail || "",
        delivery
      });
    } catch (error) {
      console.error(error);
      return send(res, 500, { error: "No fue posible verificar el estado del pago." });
    }
  }

  if (req.method === "POST" && req.url === "/api/crear-orden" && !isOrderingOpen() && !((await getStaffUser())?.role === "admin")) {
    return send(res, 403, { error: "Estamos fuera de horario. Los pedidos y pagos online están disponibles de martes a sábado, de 17:30 a 02:00. Muchas gracias por preferir La Picá del Benjamín." });
  }

  if (req.method !== "POST" || req.url !== "/api/crear-orden") {
    return send(res, 404, { error: "No encontrado" });
  }

  if (isRateLimited(req, 10, 60_000)) {
    return send(res, 429, { error: "Recibimos demasiados intentos. Espera un minuto e inténtalo nuevamente." });
  }

  try {
    if (!FRONTEND_URL) throw new Error("Falta configurar FRONTEND_URL en Render con la URL pública de tu menú.");

    const data = await readJson(req);
    if (!Array.isArray(data.items) || !data.items.length) throw new Error("Carrito vacío");

    const customerName = String(data.customer?.name || "").trim();
    const customerEmail = String(data.customer?.email || "").trim().toLowerCase();
    const method = String(data.delivery?.method || "");
    const address = String(data.delivery?.address || "").trim();
    const locality = String(data.delivery?.locality || "");

    if (!customerName) throw new Error("Falta el nombre del cliente.");
    if (!customerEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail)) {
  throw new Error("Ingresa un correo electrónico válido.");
}
    if (method === "Delivery" && !address) throw new Error("Falta la dirección de despacho.");
    if (method === "Delivery" && !Object.prototype.hasOwnProperty.call(deliveryFees, locality)) throw new Error("Selecciona una localidad de despacho válida.");
    if (method !== "Delivery" && method !== "Retiro en el local") throw new Error("Método de entrega inválido.");

    let total = 0;
    const items = data.items.map(item => {
      const price = products[item.name];
      if (!price || !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 30 || item.unit_price !== price) {
        throw new Error("Producto, cantidad o precio inválido.");
      }
      total += price * item.quantity;
      return { title: item.name, quantity: item.quantity, unit_price: String(price) };
    });

    const deliveryFee = method === "Delivery" ? deliveryFees[locality] : 0;
    if (deliveryFee > 0) { total += deliveryFee; items.push({ title: `Despacho a ${locality}`, quantity: 1, unit_price: String(deliveryFee) }); }
    if (Number(data.total_clp) !== total) throw new Error("El total del pedido no coincide.");

    const returnUrl = `${FRONTEND_URL}/?pago=retorno`;
    const payload = {
      type: "online",
      processing_mode: "manual",
      capture_mode: "automatic_async",
      total_amount: String(total),
      external_reference: randomUUID(),
      description: "Pedido La Picá del Benjamín",
     payer: {
  email: customerEmail,
  ...(method === "Delivery" ? {
    address: {
      street_name: address,
      city: locality
    }
  } : {})
},
      items,
      config: {
        online: {
          success_url: returnUrl,
          failure_url: returnUrl,
          pending_url: returnUrl,
          auto_return: "approved"
        }
      }
    };
    const response = await mpRequest("/v1/orders", {
      method: "POST",
      headers: { "X-Idempotency-Key": randomUUID() },
      body: JSON.stringify(payload)
    });

    const result = await response.json();
    console.log("MP DIAGNOSTICO DELIVERY:", JSON.stringify({
  method,
  hasShipmentRequest: Boolean(payload.shipment),
  shipmentKeys: Object.keys(payload.shipment || {}),
  hasShipmentResponse: Boolean(result?.shipment),
  checkoutUrlPresent: Boolean(result?.checkout_url),
  clientTokenPresent: Boolean(result?.client_token),
  status: result?.status
}));
    console.log("MP RESPUESTA SEGURA:", JSON.stringify({
  id: result?.id,
  type: result?.type,
  processing_mode: result?.processing_mode,
  status: result?.status,
  status_detail: result?.status_detail,
  checkout_url: result?.checkout_url || null,
  application_id: result?.integration_data?.application_id,
  config: result?.config
}, null, 2));
    console.log("MP HTTP:", response.status);
console.log("MP campos:", Object.keys(result || {}));
console.log("MP order ID:", Boolean(result?.id));
console.log("MP checkout URL:", Boolean(result?.checkout_url));
console.log("MP status:", result?.status);
    console.log("MP status_detail:", result?.status_detail);
console.log("MP config online:", Object.keys(result?.config?.online || {}));
console.log("MP country:", result?.country_code);
    console.log("MP application ID:", result?.integration_data?.application_id);
    if (!response.ok) {
      console.error("Mercado Pago:", result);
      return send(res, response.status, { error: "Mercado Pago rechazó la creación de la orden. Revisa los logs de Render." });
    }
    if (!result.checkout_url || !result.id) throw new Error("Mercado Pago no devolvió checkout_url o el ID de la orden.");
    if (dbPool) {
      const saved = await dbPool.query(
        "INSERT INTO orders (source,external_payment_id,external_reference,customer_name,customer_phone,customer_email,delivery_address,locality,delivery_method,total_clp,payment_status,delivery_status,items_json,notes,delivery_fee_clp,delivery_latitude,delivery_longitude) VALUES ('online',$1,$2,$3,$4,$5,$6,$7,$8,$9,'pending','pending',$10::jsonb,$11,$12,$13,$14) RETURNING id",
        [String(result.id),payload.external_reference,customerName,String(data.customer?.phone||"").trim(),customerEmail,method==="Delivery"?address:null,method==="Delivery"?locality:null,method,total,JSON.stringify(data.items),String(data.notes||""),deliveryFee,method==="Delivery"&&data.delivery?.latitude!==null&&data.delivery?.latitude!==undefined&&data.delivery?.latitude!==""&&Number.isFinite(Number(data.delivery.latitude))?Number(data.delivery.latitude):null,method==="Delivery"&&data.delivery?.longitude!==null&&data.delivery?.longitude!==undefined&&data.delivery?.longitude!==""&&Number.isFinite(Number(data.delivery.longitude))?Number(data.delivery.longitude):null]
      );
      const orderNumber = "PB-" + String(saved.rows[0].id).padStart(6,"0");
      await dbPool.query("UPDATE orders SET order_number=$1 WHERE id=$2",[orderNumber,saved.rows[0].id]);
    }

    return send(res, 200, { checkout_url: result.checkout_url, order_id: result.id });
  } catch (error) {
    console.error(error);
    return send(res, 400, { error: error.message || "No fue posible crear la orden." });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("Servidor de pagos iniciado en puerto " + PORT);
  initializeDatabase().catch(error => {
    console.error("PostgreSQL no disponible; pagos siguen activos:", error.message);
  });
});
