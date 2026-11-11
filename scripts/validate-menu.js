const fs = require("fs");
const path = require("path");
const file = path.join(__dirname, "..", "menu.json");
const menu = JSON.parse(fs.readFileSync(file, "utf8"));
const errors = [];
if (!Number.isInteger(menu.version) || menu.version < 1) errors.push("version debe ser un entero positivo");
if (!Array.isArray(menu.categories) || !menu.categories.length) errors.push("categories debe tener al menos una categoría");
if (!Array.isArray(menu.products) || !menu.products.length) errors.push("products debe tener al menos un producto");
const categories = new Set(menu.categories || []);
const seen = new Set();
for (const [i, p] of (menu.products || []).entries()) {
  if (!p || typeof p !== "object") { errors.push("producto "+i+" no es un objeto"); continue; }
  for (const key of ["category", "name"]) if (typeof p[key] !== "string" || !p[key].trim()) errors.push("producto "+i+": "+key+" vacío");
  if (p.category && !categories.has(p.category)) errors.push("producto "+i+": categoría no declarada ("+p.category+")");
  if (p.price_clp !== null && (!Number.isFinite(Number(p.price_clp)) || Number(p.price_clp) < 0)) errors.push("producto "+i+": precio inválido");
  if (p.option_groups !== undefined && !Array.isArray(p.option_groups)) errors.push("producto "+i+": option_groups debe ser arreglo");
  const key = String(p.category)+"::"+String(p.name);
  if (seen.has(key)) errors.push("producto duplicado: "+key);
  seen.add(key);
}
if (errors.length) { console.error("CARTA INVÁLIDA:\n- "+errors.join("\n- ")); process.exit(1); }
console.log("Carta válida: "+menu.products.length+" productos, "+menu.categories.length+" categorías, versión "+menu.version+", revisión "+(menu.revision || "sin revisión"));
