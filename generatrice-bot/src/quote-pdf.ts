// Soumission PDF au format approuvé (PRD, partie 2) : une seule page.
import { PDFDocument, PDFFont, PDFPage, PDFString, StandardFonts, rgb } from "pdf-lib";
import { phasesFor, type Model } from "./catalogue.ts";

export const SUPPLIER = {
  name: "Solution NRJ (9547-0233 Québec inc.)",
  address: "1380 Grande Allée, local 14, Terrebonne (Québec) J6W 4M3",
  phone: "438-350-6979",
  email: "ventes@solutionnrj.com",
  web: "generatricediesel.com",
  footer: "NEQ 1181176141 | TPS 742147960RT0001 | TVQ 1233000104TQ0001",
};

export const TPS_RATE = 0.05;
export const TVQ_RATE = 0.09975;
export const DEPOSIT_RATE = 0.3;

export interface QuoteClient {
  fullName: string;
  company: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
}

export interface QuoteInput {
  number: string; // S-AAAA-NNNN
  revision: number; // 1 => R01
  issuedOn: string; // AAAA-MM-JJ
  validUntil: string; // AAAA-MM-JJ
  client: QuoteClient;
  model: Model;
  quantity: number;
  /** Tension demandée par le client ; sinon celle du catalogue. */
  voltage: string | null;
  logo?: { bytes: Uint8Array; type: "png" | "jpg" } | null;
}

export interface QuoteTotals {
  subtotal: number;
  tps: number;
  tvq: number;
  total: number;
  deposit: number;
}

const cents = (value: number) => Math.round(value * 100) / 100;

export function computeTotals(unitPrice: number, quantity: number): QuoteTotals {
  const subtotal = cents(unitPrice * quantity);
  const tps = cents(subtotal * TPS_RATE);
  const tvq = cents(subtotal * TVQ_RATE);
  const total = cents(subtotal + tps + tvq);
  return { subtotal, tps, tvq, total, deposit: cents(total * DEPOSIT_RATE) };
}

export function formatMoney(value: number): string {
  // Espace insécable remplacée par une espace simple : la police standard du PDF ne la contient pas.
  return value.toLocaleString("fr-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).replace(/\s/g, " ") + " $";
}

export function formatDate(iso: string): string {
  const months = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
  const [y, m, d] = iso.split("-").map(Number);
  return `${d} ${months[m - 1]} ${y}`;
}

/** Date de validité : 3 mois après l'émission. */
export function addMonths(iso: string, months = 3): string {
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1 + months, d));
  // 30 nov. + 3 mois = 28/29 févr., pas 2 mars.
  if (date.getUTCDate() !== d) date.setUTCDate(0);
  return date.toISOString().slice(0, 10);
}

/** Les 11 lignes de description, dans l'ordre exact du PRD. */
export function descriptionRows(model: Model, voltage: string | null): [string, string][] {
  const v = voltage ?? model.voltage;
  const phases = phasesFor(v);
  return [
    ["Moteur", model.engine ?? model.brand],
    ["Puissance", `${model.powerKw} kW`],
    ["Tension", v ?? "À confirmer"],
    ["Alternateur", model.brand === "Perkins" ? "Stamford d'origine" : "À confirmer"],
    ["Phases", phases === "À confirmer" ? "À confirmer (60 Hz)" : `${phases}, 60 Hz`],
    ["Boîtier", model.enclosure === "ouvert" ? "Ouvert" : "Fermé insonorisé"],
    ["Réservoir", model.enclosure === "ouvert" ? "200 L" : model.tankLitres !== null ? `${model.tankLitres} L` : "À confirmer"],
    ["Chauffe-moteur", "Inclus"],
    ["Chargeur de batterie", "Intelligent, inclus"],
    ["Contrôleur", "Deep Sea DSE6120"],
    ["Certifications", "CSA · EPA"],
  ];
}

const NAVY = rgb(0x0b / 255, 0x3b / 255, 0x66 / 255);
const ORANGE = rgb(0xc2 / 255, 0x41 / 255, 0x0c / 255);
const INK = rgb(0.1, 0.13, 0.17);
const MUTED = rgb(0.36, 0.42, 0.48);
const LINE = rgb(0.82, 0.85, 0.88);
const WHITE = rgb(1, 1, 1);

function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(" ")) {
      const candidate = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, size) <= width) line = candidate;
      else {
        if (line) lines.push(line);
        line = word;
      }
    }
    lines.push(line);
  }
  return lines;
}

export async function buildQuotePdf(input: QuoteInput): Promise<Uint8Array> {
  if (input.model.priceCad === null) throw new Error("price_on_request");
  const doc = await PDFDocument.create();
  doc.setTitle(`Soumission ${input.number}`);
  doc.setAuthor("Solution NRJ");
  doc.setLanguage("fr-CA");
  const page = doc.addPage([612, 792]); // lettre
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const M = 40; // marge
  const W = 612 - 2 * M;
  let y = 792 - M;

  const text = (p: PDFPage, s: string, x: number, yy: number, size = 9, font = regular, color = INK) =>
    p.drawText(s, { x, y: yy, size, font, color });
  const right = (s: string, xRight: number, yy: number, size = 9, font = regular, color = INK) =>
    text(page, s, xRight - font.widthOfTextAtSize(s, size), yy, size, font, color);

  // 1. En-tête : logo, « SOUMISSION », numéro.
  if (input.logo) {
    const image = input.logo.type === "png" ? await doc.embedPng(input.logo.bytes) : await doc.embedJpg(input.logo.bytes);
    const h = 42;
    const w = Math.min(180, (image.width / image.height) * h);
    page.drawImage(image, { x: M, y: y - h, width: w, height: (image.height / image.width) * w });
  } else {
    text(page, "Solution NRJ", M, y - 26, 22, bold, NAVY);
  }
  right("SOUMISSION", M + W, y - 18, 20, bold, NAVY);
  right(`${input.number} - R${String(input.revision).padStart(2, "0")}`, M + W, y - 34, 10, bold, INK);
  y -= 58;
  page.drawLine({ start: { x: M, y }, end: { x: M + W, y }, thickness: 1.5, color: NAVY });
  y -= 16;

  // 2. Fournisseur | Client, côte à côte.
  const colW = (W - 20) / 2;
  const block = (title: string, lines: string[], x: number) => {
    let yy = y;
    text(page, title, x, yy, 8, bold, MUTED);
    yy -= 13;
    lines.forEach((line, i) => {
      for (const part of wrap(line, i === 0 ? bold : regular, 9, colW)) {
        text(page, part, x, yy, 9, i === 0 ? bold : regular);
        yy -= 12;
      }
    });
    return yy;
  };
  const c = input.client;
  const clientLines = [c.fullName, c.company, c.address, c.phone, c.email].filter((v): v is string => Boolean(v && v.trim()));
  const yA = block("FOURNISSEUR", [SUPPLIER.name, SUPPLIER.address, `${SUPPLIER.phone} · ${SUPPLIER.email}`, SUPPLIER.web], M);
  const yB = block("CLIENT", clientLines, M + colW + 20);
  y = Math.min(yA, yB) - 6;

  // 3. Dates.
  page.drawRectangle({ x: M, y: y - 6, width: W, height: 20, color: rgb(0.95, 0.96, 0.97) });
  text(
    page,
    `Émise le ${formatDate(input.issuedOn)}   |   Révision du ${formatDate(input.issuedOn)}   |   Valide jusqu'au ${formatDate(input.validUntil)}`,
    M + 8,
    y,
    9,
  );
  y -= 34;

  // 4. Titre.
  const title = `Génératrice diesel ${input.model.brand} ${input.model.powerKw} kW`;
  text(page, title, M, y, 16, bold, NAVY);
  y -= 22;

  // 5. Description sur 2 colonnes (gauche puis droite).
  const rows = descriptionRows(input.model, input.voltage);
  const half = Math.ceil(rows.length / 2);
  const columns = [rows.slice(0, half), rows.slice(half)];
  const rowH = 17;
  columns.forEach((col, ci) => {
    const x = M + ci * (colW + 20);
    col.forEach(([label, value], ri) => {
      const yy = y - ri * rowH;
      text(page, label, x, yy, 9, bold, MUTED);
      text(page, value, x + 110, yy, 9, regular, INK);
      page.drawLine({ start: { x, y: yy - 5 }, end: { x: x + colW, y: yy - 5 }, thickness: 0.5, color: LINE });
    });
  });
  y -= half * rowH + 4;
  const small = [
    input.model.dimensions ? `Dimensions : ${input.model.dimensions}.` : null,
    "Préparation huile et liquide de refroidissement Prestone. Garantie 1 an ou 1 500 heures, selon la première limite atteinte.",
  ].filter(Boolean).join(" ");
  for (const line of wrap(small, regular, 7.5, W)) {
    text(page, line, M, y, 7.5, regular, MUTED);
    y -= 10;
  }
  y -= 12;

  // 6. Prix et taxes.
  const totals = computeTotals(input.model.priceCad, input.quantity);
  page.drawRectangle({ x: M, y: y - 5, width: W, height: 18, color: rgb(0.93, 0.95, 0.97) });
  text(page, "Description", M + 6, y, 8.5, bold, MUTED);
  right("Qté", M + W - 190, y, 8.5, bold, MUTED);
  right("Prix unitaire", M + W - 90, y, 8.5, bold, MUTED);
  right("Montant", M + W - 6, y, 8.5, bold, MUTED);
  y -= 20;
  text(page, title, M + 6, y, 10, bold);
  right(String(input.quantity), M + W - 190, y, 10);
  right(formatMoney(input.model.priceCad), M + W - 90, y, 10);
  right(formatMoney(totals.subtotal), M + W - 6, y, 10, bold);
  y -= 10;
  page.drawLine({ start: { x: M, y }, end: { x: M + W, y }, thickness: 0.5, color: LINE });
  y -= 18;

  const totalsX = M + W - 230;
  const conditions = [
    "Installation, disponibilité et délai à confirmer.",
    "Même prix selon la tension.",
    "Aucun retour une fois la commande confirmée.",
  ];
  let yc = y;
  for (const line of conditions) {
    text(page, line, M, yc, 8.5, regular, INK);
    yc -= 13;
  }
  text(page, "Voir la fiche et les photos en ligne", M, yc, 8.5, bold, NAVY);
  const linkW = bold.widthOfTextAtSize("Voir la fiche et les photos en ligne", 8.5);
  page.drawLine({ start: { x: M, y: yc - 2 }, end: { x: M + linkW, y: yc - 2 }, thickness: 0.5, color: NAVY });
  addLink(doc, page, input.model.url, M, yc - 3, linkW, 11);

  let yt = y;
  const totalRow = (label: string, value: string) => {
    text(page, label, totalsX, yt, 9);
    right(value, M + W - 6, yt, 9);
    yt -= 15;
  };
  totalRow("Sous-total", formatMoney(totals.subtotal));
  totalRow("TPS (5 %)", formatMoney(totals.tps));
  totalRow("TVQ (9,975 %)", formatMoney(totals.tvq));
  yt -= 8;
  page.drawRectangle({ x: totalsX - 6, y: yt - 7, width: M + W - totalsX + 6, height: 22, color: NAVY });
  text(page, "TOTAL CAD", totalsX, yt, 10.5, bold, WHITE);
  right(formatMoney(totals.total), M + W - 6, yt, 10.5, bold, WHITE);
  yt -= 28;
  page.drawRectangle({ x: totalsX - 6, y: yt - 8, width: M + W - totalsX + 6, height: 24, color: ORANGE });
  text(page, "DÉPÔT REQUIS (30 %)", totalsX, yt, 10.5, bold, WHITE);
  right(formatMoney(totals.deposit), M + W - 6, yt, 10.5, bold, WHITE);
  y = Math.min(yt - 30, yc - 30);

  // 7. Acceptation du client.
  text(page, "ACCEPTATION DU CLIENT", M, y, 8, bold, MUTED);
  y -= 30;
  const fieldW = (W - 40) / 3;
  ["Nom", "Signature", "Date"].forEach((label, i) => {
    const x = M + i * (fieldW + 20);
    page.drawLine({ start: { x, y }, end: { x: x + fieldW, y }, thickness: 0.7, color: INK });
    text(page, label, x, y - 11, 8, regular, MUTED);
  });
  y -= 30;
  text(page, "Pour accepter, signez et retournez cette soumission par courriel.", M, y, 9, bold, INK);

  // 8. Pied de page.
  page.drawLine({ start: { x: M, y: 46 }, end: { x: M + W, y: 46 }, thickness: 0.5, color: LINE });
  const footerW = regular.widthOfTextAtSize(SUPPLIER.footer, 7.5);
  text(page, SUPPLIER.footer, M + (W - footerW) / 2, 34, 7.5, regular, MUTED);

  return doc.save();
}

function addLink(doc: PDFDocument, page: PDFPage, url: string, x: number, y: number, w: number, h: number) {
  const link = doc.context.register(
    doc.context.obj({
      Type: "Annot",
      Subtype: "Link",
      Rect: [x, y, x + w, y + h],
      Border: [0, 0, 0],
      A: { Type: "Action", S: "URI", URI: PDFString.of(url) },
    }),
  );
  page.node.addAnnot(link);
}
