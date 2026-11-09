const http = require("http");
const { randomUUID, randomBytes, scryptSync, timingSafeEqual, createHash } = require("crypto");
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
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS app_users (
      id BIGSERIAL PRIMARY KEY,
      username VARCHAR(80) UNIQUE NOT NULL,
      full_name VARCHAR(120) NOT NULL,
      role VARCHAR(20) NOT NULL CHECK (role IN ('admin','driver')),
      password_salt TEXT,
      password_hash TEXT,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    INSERT INTO app_users (username, full_name, role) VALUES
      ('jefa', 'Michelle Ibáñez', 'admin'),
      ('maximo', 'Máximo Palma', 'driver'),
      ('claudio', 'Claudio Scheid', 'driver')
    ON CONFLICT (username) DO UPDATE
      SET full_name = EXCLUDED.full_name, role = EXCLUDED.role;
    CREATE TABLE IF NOT EXISTS app_sessions (\n      token_hash TEXT PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,\n      expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()\n    );\n    CREATE TABLE IF NOT EXISTS drivers (
      id BIGSERIAL PRIMARY KEY, display_name VARCHAR(120) NOT NULL,
      username VARCHAR(80) UNIQUE NOT NULL, password_hash TEXT NOT NULL,
      active BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
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
  await dbPool.query("DELETE FROM app_sessions WHERE expires_at < NOW()");\n  const tempPassword = process.env.INITIAL_TEMP_PASSWORD;\n  if (tempPassword) {\n    for (const username of ["jefa", "maximo", "claudio"]) {\n      const row = await dbPool.query("SELECT password_hash FROM app_users WHERE username=$1", [username]);\n      if (row.rows[0] && !row.rows[0].password_hash) {\n        const salt = randomBytes(16).toString("hex");\n        const hash = scryptSync(tempPassword, salt, 64).toString("hex");\n        await dbPool.query("UPDATE app_users SET password_salt=$1,password_hash=$2 WHERE username=$3", [salt, hash, username]);\n      }\n    }\n  }\n  console.log("PostgreSQL conectado; esquema inicial verificado.");
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
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");\n  res.setHeader("Access-Control-Allow-Credentials", "true");

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
      res.setHeader("Set-Cookie", "pb_session="+token+"; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=43200");
      return send(res, 200, { user: { username:user.username, full_name:user.full_name, role:user.role }, mustChangePassword: user.password_hash === process.env.INITIAL_TEMP_PASSWORD });
    } catch (error) { console.error("Login error:", error.message); return send(res, 400, { error: "No fue posible iniciar sesión." }); }
  }

  if (req.method === "POST" && requestPath === "/api/personal/logout") {
    const token = (req.headers.cookie || "").split(";").map(x=>x.trim()).find(x=>x.startsWith("pb_session="))?.slice(11);
    if (token && dbPool) await dbPool.query("DELETE FROM app_sessions WHERE token_hash=$1", [createHash("sha256").update(token).digest("hex")]);
    res.setHeader("Set-Cookie", "pb_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0");
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
      await dbPool.query("UPDATE app_users SET password_salt=$1,password_hash=$2 WHERE id=$3", [salt,hash,session.rows[0].user_id]);
      return send(res, 200, { ok:true, message:"Contraseña actualizada." });
    } catch (error) { console.error("Password update error:",error.message); return send(res,400,{error:"No fue posible cambiar la contraseña."}); }
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

  if (req.method === "POST" && req.url === "/api/crear-orden" && !isOrderingOpen()) {
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
