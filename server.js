const http = require("http");
const { randomUUID } = require("crypto");

const PORT = process.env.PORT || 3000;
const MP_API = "https://api.mercadopago.com";
const FRONTEND_URL = (process.env.FRONTEND_URL || "").replace(/\/+$/, "");

const deliveryFees = { "Linares":1990, "Longaví":3500, "Yerbas Buenas":3000, "Colbún":4000, "Villa Alegre":4000, "San Javier":5000, "Palmilla":5000 };

const products = {
  "California Rolls": 4700, "Tempura o Panko": 4900, "Salmón": 5500,
  "Avocado": 4900, "Hosomaki": 2350, "Chicken (10 cortes)": 5390,
  "Fresh (10 cortes)": 4990, "Mechada Rolls (10 cortes)": 5490,
  "Tropical Spicy (10 cortes)": 5890, "Tor Rolls (10 cortes)": 5550,
  "Delicious Rolls (10 cortes)": 5890, "Nigiri (2 bocados)": 3300,
  "Sashimi 3 cortes": 3200, "Sashimi 6 cortes": 5200, "Sashimi 9 cortes": 6900,
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

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
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

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  if (req.method === "GET" && req.url === "/") {
    return send(res, 200, { status: "Servidor activo" });
  }

  // Consultar la orden directamente en Mercado Pago; nunca confiar en el estado de la URL.
  const orderMatch = req.method === "GET" && req.url.match(/^\/api\/orden\/([A-Za-z0-9_-]+)$/);
  if (orderMatch) {
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

      const shipmentAddress = order.payer?.address || order.shipment?.address || {};
      const addressParts = [
        shipmentAddress.street_name,
        shipmentAddress.street_number,
        shipmentAddress.complement,
        shipmentAddress.neighborhood,
        shipmentAddress.city,
        shipmentAddress.state
      ].filter(Boolean);

      return send(res, 200, {
        approved,
        status: order.status || "unknown",
        status_detail: order.status_detail || "",
        customer_address: addressParts.join(", "),
        delivery: Boolean(addressParts.length)
      });
    } catch (error) {
      console.error(error);
      return send(res, 500, { error: "No fue posible verificar el estado del pago." });
    }
  }

  if (req.method !== "POST" || req.url !== "/api/crear-orden") {
    return send(res, 404, { error: "No encontrado" });
  }

  try {
    if (!FRONTEND_URL) throw new Error("Falta configurar FRONTEND_URL en Render con la URL pública de tu menú.");

    const data = await readJson(req);
    if (!Array.isArray(data.items) || !data.items.length) throw new Error("Carrito vacío");

    const customerName = String(data.customer?.name || "").trim();
    const customerEmail = String(data.customer?.email || "").trim().toLowerCase();
    const method = String(data.delivery?.method || "");
    const address = String(data.delivery?.address || "").trim();\n    const locality = String(data.delivery?.locality || "");

    if (!customerName) throw new Error("Falta el nombre del cliente.");
    if (!customerEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail)) {
  throw new Error("Ingresa un correo electrónico válido.");
}
    if (method === "Delivery" && !address) throw new Error("Falta la dirección de despacho.");\n    if (method === "Delivery" && !Object.prototype.hasOwnProperty.call(deliveryFees, locality)) throw new Error("Selecciona una localidad de despacho válida.");
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

    const deliveryFee = method === "Delivery" ? deliveryFees[locality] : 0;\n    if (deliveryFee > 0) { total += deliveryFee; items.push({ title: `Despacho a ${locality}`, quantity: 1, unit_price: String(deliveryFee) }); }\n    if (Number(data.total_clp) !== total) throw new Error("El total del pedido no coincide.");

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
});
