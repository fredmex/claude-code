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
  /** Photo du site pour les cartes Messenger ; null = carte sans photo (ne jamais inventer d'URL). */
  imageUrl: string | null;
  /** Soumission automatique permise (modèle du catalogue de soumissions officiel). */
  quotable: boolean;
}

/** Conditions imprimées sur chaque soumission (catalogue-soumissions.json). */
export const QUOTE_CONDITIONS = [
  "Installation, disponibilité et délai à confirmer.",
  "Le prix du même modèle est identique selon la tension.",
  "Aucun retour une fois la commande confirmée.",
];

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
    imageUrl: null,
    quotable: false,
    ...fields,
  };
}

export const CATALOGUE: Model[] = [
  perkins(10, { quotable: true, priceCad: 12500, engine: "Perkins diesel, 3 cylindres", voltage: "120/240 V", tankLitres: 50, stock: "En stock (3 unités)" }),
  perkins(15, { quotable: true, priceCad: 16000, engine: "Perkins diesel 403D-15, 3 cylindres", voltage: "120/240 V", tankLitres: 50, stock: "En stock", notes: "Autonomie annoncée de 12 h selon la charge." }),
  perkins(20, { quotable: true, priceCad: 21000, engine: "Perkins diesel, 4 cylindres", voltage: "120/240 V", tankLitres: 400 }),
  perkins(20, { key: "perkins-20-ouverte", quotable: true, priceCad: 17000, engine: "Perkins diesel, 4 cylindres", voltage: "120/240 V", tankLitres: 200, enclosure: "ouvert", stock: "Sur demande", notes: "À présenter seulement si le client demande une version ouverte.", url: "https://generatricediesel.com/modeles-perkins/" }),
  perkins(25, {}),
  perkins(30, { quotable: true, priceCad: 26000, engine: "Perkins diesel 404D-22TG, 4 cylindres, 2,2 L, turbo", voltage: "120/240 V", tankLitres: 400, notes: "Ne pas promettre 30 kW électriques en continu." }),
  perkins(40, { quotable: true, priceCad: 29000, engine: "Perkins diesel 1104A-44, 4 cylindres, 4,4 L", voltage: "120/240 V", tankLitres: 400, notes: "167 A." }),
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
    notes: "Pas de soumission automatique : un conseiller la prépare.",
    url: "https://generatricediesel.com/product/kubotaa-generatrice-diesel-40kw/",
    imageUrl: null,
    quotable: false,
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
    notes: "Pas de soumission automatique : un conseiller la prépare.",
    url: "https://generatricediesel.com/product/kubotaa-generatrice-diesel-40kw/",
    imageUrl: null,
    quotable: false,
  },
  perkins(50, { quotable: true, priceCad: 31000, engine: "Perkins diesel 1104A-44, 4 cylindres, 4,4 L", voltage: "120/240 V", tankLitres: 400 }),
  perkins(60, { quotable: true, priceCad: 35000, engine: "Perkins diesel", voltage: "120/240 V", tankLitres: 400, dimensions: "98,43 × 41,34 po (250 × 105 cm), longueur × largeur", stock: "En stock" }),
  perkins(80, { quotable: true, priceCad: 39000, engine: "Perkins diesel 1104C-44TAG1, 4 cylindres, 4,4 L", voltage: "120/240 V", tankLitres: 600 }),
  perkins(100, { quotable: true, priceCad: 44000, engine: "Perkins diesel", voltage: "120/240 V", tankLitres: 600, dimensions: "102 × 43 po (259 × 109 cm), longueur × largeur", stock: "En stock" }),
  perkins(150, { quotable: true, priceCad: 49000, engine: "Perkins diesel", voltage: "600 V", tankLitres: 600, dimensions: "125,98 × 44,49 po (320 × 113 cm), longueur × largeur", notes: "Autonomie annoncée de 12 h." }),
  perkins(200, {}),
  perkins(300, {}),
  perkins(400, {}),
];

// Les fiches 25, 200, 300 et 400 kW n'existent pas sur le site : on renvoie au catalogue.
for (const model of CATALOGUE) {
  if ([25, 200, 300, 400].includes(model.powerKw)) model.url = "https://generatricediesel.com/modeles-perkins/";
}

export const QUOTABLE_KEYS = CATALOGUE.filter((m) => m.quotable).map((m) => m.key);

export const MODEL_KEYS = CATALOGUE.map((model) => model.key);

export function findModel(key: string): Model | undefined {
  return CATALOGUE.find((model) => model.key === key);
}

/** Phases déduites de la tension (règle du générateur officiel). */
export function phasesFor(voltage: string | null): string {
  const v = (voltage ?? "").replace(/\s/g, "").toUpperCase();
  if (["120/240V", "240V", "120V"].includes(v)) return "Monophasé";
  if (["120/208V", "208V", "347/600V", "600V", "480V", "277/480V"].includes(v)) return "Triphasé";
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
      m.quotable ? null : "pas de soumission automatique",
    ].filter(Boolean);
    return `- [${m.key}] ${m.brand} ${m.powerKw} kW${m.enclosure === "ouvert" ? " ouverte" : ""} : ${parts.join(" — ")} — ${m.url}`;
  }).join("\n");
}
