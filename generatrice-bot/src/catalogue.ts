// Catalogue Solution NRJ, repris du PRD (15 oct. 2026). C'est la seule source
// des prix et caractéristiques : le bot, les fiches et les soumissions PDF en
// dépendent. Ne jamais y mettre de coûts fournisseur.

export interface Model {
  key: string;
  brand: "Perkins" | "Kubota";
  powerKw: number;
  /** Nom affiché, ex. « Génératrice diesel Perkins 40 kW ». */
  name: string;
  /** Prix avant taxes en $ CA ; null = sur demande. */
  priceCad: number | null;
  engine: string | null;
  voltage: string | null;
  tankLitres: number | null;
  enclosure: "fermé insonorisé" | "ouvert";
  dimensions: string | null;
  stock: string | null;
  notes: string | null;
  url: string;
}

const productUrl = (kw: number) => `https://generatricediesel.com/product/generatrice-diesel-${kw}kw/`;

function perkins(kw: number, fields: Partial<Model> & { key?: string }): Model {
  return {
    key: fields.key ?? `perkins-${kw}`,
    brand: "Perkins",
    powerKw: kw,
    name: `Génératrice diesel Perkins ${kw} kW${fields.enclosure === "ouvert" ? " (ouverte)" : ""}`,
    priceCad: null,
    engine: null,
    voltage: null,
    tankLitres: null,
    enclosure: "fermé insonorisé",
    dimensions: null,
    stock: null,
    notes: null,
    url: productUrl(kw),
    ...fields,
  };
}

export const CATALOGUE: Model[] = [
  perkins(10, { priceCad: 12500, engine: "Perkins 3 cylindres", voltage: "120/240 V", tankLitres: 50, stock: "En stock (3 unités)" }),
  perkins(15, { priceCad: 16000, engine: "Perkins 403D-15, 3 cylindres", voltage: "120/240 V", tankLitres: 50, stock: "En stock", notes: "Autonomie annoncée de 12 h selon la charge." }),
  perkins(20, { priceCad: 21000, engine: "Perkins 4 cylindres", voltage: "120/240 V", tankLitres: 400 }),
  perkins(20, { key: "perkins-20-ouverte", priceCad: 17000, engine: "Perkins 4 cylindres", voltage: "120/240 V", tankLitres: 200, enclosure: "ouvert", stock: "Sur demande" }),
  perkins(25, {}),
  perkins(30, { priceCad: 26000, engine: "Perkins 404D-22TG, 4 cylindres, 2,2 L turbo", voltage: "120/240 V", tankLitres: 400, notes: "Ne pas promettre 30 kW électriques en continu." }),
  perkins(40, { priceCad: 29000, engine: "Perkins 1104A-44, 4 cylindres, 4,4 L", voltage: "120/240 V", tankLitres: 400, notes: "167 A." }),
  {
    key: "kubota-40",
    brand: "Kubota",
    powerKw: 40,
    name: "Génératrice diesel Kubota 40 kW",
    priceCad: 28000,
    engine: "Kubota V3600-TE3BG",
    voltage: null,
    tankLitres: null,
    enclosure: "fermé insonorisé",
    dimensions: null,
    stock: null,
    notes: null,
    url: "https://generatricediesel.com/product/kubotaa-generatrice-diesel-40kw/",
  },
  {
    key: "kubota-40-ouverte",
    brand: "Kubota",
    powerKw: 40,
    name: "Génératrice diesel Kubota 40 kW (ouverte)",
    priceCad: 26000,
    engine: "Kubota V3600-TE3BG",
    voltage: null,
    tankLitres: 200,
    enclosure: "ouvert",
    dimensions: null,
    stock: null,
    notes: null,
    url: "https://generatricediesel.com/product/kubotaa-generatrice-diesel-40kw/",
  },
  perkins(50, { priceCad: 31000, engine: "Perkins 1104A-44", voltage: "120/240 V", tankLitres: 400 }),
  perkins(60, { priceCad: 35000, engine: "Perkins", voltage: "120/240 V", tankLitres: 400, dimensions: "98,43 × 41,34 po", stock: "En stock" }),
  perkins(80, { priceCad: 39000, engine: "Perkins 1104C-44TAG1", voltage: "120/240 V", tankLitres: 600 }),
  perkins(100, { priceCad: 44000, engine: "Perkins", voltage: "120/240 V", tankLitres: 600, dimensions: "102 × 43 po", stock: "En stock" }),
  perkins(150, { priceCad: 49000, engine: "Perkins", voltage: "600 V", tankLitres: 600, dimensions: "125,98 × 44,49 po", notes: "Autonomie annoncée de 12 h." }),
  perkins(200, {}),
  perkins(300, {}),
  perkins(400, {}),
];

// Les fiches 25, 200, 300 et 400 kW n'existent pas sur le site : on renvoie au catalogue.
for (const model of CATALOGUE) {
  if ([25, 200, 300, 400].includes(model.powerKw)) model.url = "https://generatricediesel.com/modeles-perkins/";
}

export const MODEL_KEYS = CATALOGUE.map((model) => model.key);

export function findModel(key: string): Model | undefined {
  return CATALOGUE.find((model) => model.key === key);
}

/** Phases déduites de la tension (règle du PRD). */
export function phasesFor(voltage: string | null): string {
  const v = (voltage ?? "").replace(/\s/g, "");
  if (v.includes("120/240")) return "Monophasé";
  if (/120\/208|347\/600|^600V?$/.test(v)) return "Triphasé";
  return "À confirmer";
}

const money = (value: number) => value.toLocaleString("fr-CA");

/** Section « Gamme et prix » du prompt, générée depuis le catalogue. */
export function catalogueForPrompt(): string {
  return CATALOGUE.map((m) => {
    const parts = [
      m.priceCad !== null ? `${money(m.priceCad)} $` : "prix sur demande",
      m.engine,
      m.voltage,
      m.tankLitres !== null ? `réservoir ${m.tankLitres} L` : null,
      m.enclosure === "ouvert" ? "ouverte" : null,
      m.dimensions,
      m.stock,
      m.notes,
    ].filter(Boolean);
    return `- [${m.key}] ${m.brand} ${m.powerKw} kW${m.enclosure === "ouvert" ? " ouverte" : ""} : ${parts.join(" — ")} — ${m.url}`;
  }).join("\n");
}
