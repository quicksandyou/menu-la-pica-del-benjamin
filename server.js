const http = require("http");
const { randomUUID } = require("crypto");

const PORT = process.env.PORT || 3000;

const products = {
  "California Rolls": 4700,
  "Tempura o Panko": 4900,
  "Salmón": 5500,
  "Avocado": 4900,
  "Hosomaki": 2350,
  "Chicken (10 cortes)": 5390,
  "Fresh (10 cortes)": 4990,
  "Mechada Rolls (10 cortes)": 5490,
  "Tropical Spicy (10 cortes)": 5890,
  "Tor Rolls (10 cortes)": 5550,
  "Delicious Rolls (10 cortes)": 5890,
  "Nigiri (2 bocados)": 3300,
  "Sashimi 3 cortes": 3200,
  "Sashimi 6 cortes": 5200,
  "Sashimi 9 cortes": 6900,
  "Ceviche camarón-salmón": 7990,
  "Ceviche mixto": 9490,
  "Gohan a elección": 5990,
  "Napolitana": 7990,
  "Pollo champiñón": 8990,
  "Cuatro estaciones": 8990,
  "Peperoni": 7990,
  "Especial carne": 8990,
  "Mexicana": 8990,
  "Mediterránea": 9990,
  "Mechada choclo": 8990,
  "Carnes mixtas": 8990,
  "Clásico de la casa": 4990,
  "Chacarero": 4990,
  "Barros Luco": 4990,
  "Benjita": 6490,
  "Sándwich del chef": 5990,
  "A lo pobre": 5990,
  "Vegetariano": 6490,
  "Mexicano": 5990,
  "Chileno": 5990,
  "Cheese Cream": 6890,
  "Chicken": 6990
};

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  const allowed = process.env.FRONTEND_URL;

  if (origin && origin === allowed) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }

  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ status: "Servidor activo" }));
  }

  if (req.method !== "POST" || req.url !== "/api/crear-orden") {
    res.writeHead(404);
    return res.end("No encontrado");
  }

  try {
    let raw = "";
    for await (const chunk of req) raw += chunk;

    if (raw.length > 50000) throw new Error("Pedido demasiado grande");

    const data = JSON.parse(raw);

    if (!Array.isArray(data.items) || !data.items.length) {
      throw new Error("Carrito vacío");
    }

    let total = 0;
    const items = data.items.map(item => {
      const price = products[item.name];

      if (!price || !Number.isInteger(item.quantity) ||
          item.quantity < 1 || item.quantity > 30 ||
          item.unit_price !== price) {
        throw new Error("Producto o precio inválido");
      }

      total += price * item.quantity;

      return {
        title: item.name,
        quantity: item.quantity,
        unit_price: String(price)
      };
    });

    const token = process.env.MP_ACCESS_TOKEN;

    if (!token) throw new Error("Falta configurar Mercado Pago");

    const response = await fetch(
      "https://api.mercadopago.com/v1/orders",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`,
          "X-Idempotency-Key": randomUUID()
        },
        body: JSON.stringify({
          type: "online",
          processing_mode: "manual",
          capture_mode: "automatic_async",
          total_amount: String(total),
          external_reference: randomUUID(),
          description: "Pedido La Picá del Benjamín",
          items
        })
      }
    );

    const result = await response.json();

    if (!response.ok) {
      console.error("Mercado Pago:", result);
      throw new Error("Mercado Pago rechazó la orden");
    }

    res.writeHead(200, {
      "Content-Type": "application/json"
    });

    res.end(JSON.stringify({
      checkout_url: result.checkout_url
    }));

  } catch (error) {
    console.error(error);

    res.writeHead(400, {
      "Content-Type": "application/json"
    });

    res.end(JSON.stringify({
      error: error.message
    }));
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("Servidor de pagos iniciado en puerto " + PORT);
});
