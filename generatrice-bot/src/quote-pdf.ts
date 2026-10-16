// Soumission PDF au format approuvé (PRD, partie 2) : une seule page.
import { PDFDocument, PDFFont, PDFPage, PDFString, StandardFonts, rgb } from "pdf-lib";
import { phasesFor, QUOTE_CONDITIONS, type Model } from "./catalogue.ts";

export const SUPPLIER = {
  name: "Solution NRJ (9547-0233 Québec inc.)",
  address: "1380 Grande Allée, local 14, Terrebonne (Québec) J6W 4M3",
  phone: "438-350-6979",
  email: "ventes@solutionnrj.com",
  web: "generatricediesel.com",
  footer: "NEQ : 1181176141 | TPS : 742147960RT0001 | TVQ : 1233000104TQ0001",
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

/** Taxes calculées en cents entiers, arrondi au cent supérieur à 0,5 (comme le générateur officiel). */
export function computeTotals(unitPrice: number, quantity: number): QuoteTotals {
  if (!Number.isInteger(quantity) || quantity <= 0) throw new Error("quantity_invalid");
  if (!(unitPrice > 0)) throw new Error("price_invalid");
  const subtotal = Math.round(unitPrice * 100) * quantity;
  const tps = Math.round((subtotal * 5) / 100);
  const tvq = Math.round((subtotal * 9975) / 100000);
  const total = subtotal + tps + tvq;
  const deposit = Math.round((total * 30) / 100);
  return { subtotal: subtotal / 100, tps: tps / 100, tvq: tvq / 100, total: total / 100, deposit: deposit / 100 };
}

/** « 40 241,25 $ » */
export function formatMoney(value: number): string {
  const [int, dec] = value.toFixed(2).split(".");
  return int.replace(/\B(?=(\d{3})+(?!\d))/g, " ") + "," + dec + " $";
}

export function formatDate(iso: string): string {
  const months = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
  const [y, m, d] = iso.split("-").map(Number);
  return `${d} ${months[m - 1]} ${y}`;
}

/** Validité : 3 mois calendaires, plafonnée à la fin du mois (30 nov. → 28 févr.). */
export function addMonths(iso: string, months = 3): string {
  const [y, m, d] = iso.split("-").map(Number);
  const n = y * 12 + (m - 1) + months;
  const year = Math.floor(n / 12);
  const month = (n % 12) + 1;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${String(month).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
}

/** Les 11 lignes de description, dans l'ordre demandé par Frederic (15 oct. 2026). */
export function descriptionRows(model: Model, voltage: string | null): [string, string][] {
  const v = voltage ?? model.voltage;
  const opened = model.enclosure === "ouvert";
  return [
    ["Moteur", model.engine ?? `${model.brand} diesel`],
    ["Puissance", `${model.powerKw} kW`],
    ["Tension", v ?? "À confirmer"],
    ["Alternateur", "Stamford d'origine"],
    ["Phases", `${phasesFor(v)} · 60 Hz`],
    ["Boîtier", opened ? "Ouvert" : "Fermé insonorisé"],
    ["Réservoir", opened ? "200 litres" : model.tankLitres !== null ? `${model.tankLitres} litres` : "À confirmer"],
    ["Chauffe-moteur", "Inclus"],
    ["Chargeur de batterie", "Intelligent, inclus"],
    ["Contrôleur", "Deep Sea DSE6120"],
    ["Certifications", "CSA · EPA"],
  ];
}

// Couleurs du générateur officiel (crm/generer_soumission.py).
const hex = (h: string) => rgb(parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255);
const NAVY = hex("#173A59");
const INK = hex("#243444");
const PALE = hex("#EFF4F8");
const LINE = hex("#D8E2EB");
const DEPOSIT = hex("#B45309");
const SMALL = hex("#586A79");
const BOLT = hex("#1EA7E1");
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
  const rev = `R${String(input.revision).padStart(2, "0")}`;
  doc.setTitle(`Solution NRJ - ${input.number} ${rev}`);
  doc.setAuthor("Solution NRJ");
  doc.setLanguage("fr-CA");
  // Dates fixes : les mêmes données donnent exactement le même PDF (nécessaire pour
  // l'idempotence de Resend, qui refuse une même clé avec un contenu différent).
  const fixed = new Date(`${input.issuedOn}T12:00:00Z`);
  doc.setCreationDate(fixed);
  doc.setModificationDate(fixed);
  const page = doc.addPage([612, 792]); // lettre
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const L = 40;
  const R = 572;
  const W = R - L; // 532

  const text = (s: string, x: number, y: number, size = 9.3, font = regular, color = INK) => page.drawText(s, { x, y, size, font, color });
  const right = (s: string, xr: number, y: number, size = 9.3, font = regular, color = INK) =>
    text(s, xr - font.widthOfTextAtSize(s, size), y, size, font, color);
  const hline = (y: number, x1 = L, x2 = R, thickness = 0.6, color = LINE) => page.drawLine({ start: { x: x1, y }, end: { x: x2, y }, thickness, color });
  const section = (label: string, y: number) => {
    page.drawRectangle({ x: L, y: y - 7, width: W, height: 22, color: PALE });
    text(label, L + 10, y, 9.3, bold);
  };

  // En-tête : carré marine avec éclair, « Solution NRJ », « SOUMISSION », numéro.
  // drawSvgPath place le point (px, py) en (x + px, y - py) : les y sont donc négatifs ici.
  const roundRect = (x0: number, y0: number, w: number, h: number, r: number) =>
    `M ${x0 + r} ${-y0} H ${x0 + w - r} Q ${x0 + w} ${-y0} ${x0 + w} ${-(y0 + r)} V ${-(y0 + h - r)} Q ${x0 + w} ${-(y0 + h)} ${x0 + w - r} ${-(y0 + h)} ` +
    `H ${x0 + r} Q ${x0} ${-(y0 + h)} ${x0} ${-(y0 + h - r)} V ${-(y0 + r)} Q ${x0} ${-y0} ${x0 + r} ${-y0} Z`;
  page.drawSvgPath(roundRect(L, 727, 46, 46, 10), { x: 0, y: 0, color: NAVY });
  page.drawSvgPath("M 66 -766 L 51 -746 L 61 -746 L 57 -731 L 75 -753 L 65 -753 Z", { x: 0, y: 0, color: BOLT });
  text("Solution NRJ", 97, 742, 23, bold, NAVY);
  right("SOUMISSION", R, 750, 15, bold, NAVY);
  right(`${input.number} - ${rev}`, R, 731, 10, bold, NAVY);
  hline(718, L, R, 2, NAVY);

  // Fournisseur | Client.
  let y = 698;
  const c = input.client;
  const supplier = [SUPPLIER.name, SUPPLIER.address, `${SUPPLIER.phone} · ${SUPPLIER.email}`, SUPPLIER.web];
  // Seulement ce que le client a donné : jamais de ligne « non précisé ».
  const buyer = [c.fullName, c.company, c.address, [c.phone, c.email].filter(Boolean).join(" · ")].filter((v): v is string => Boolean(v && v.trim()));
  text("FOURNISSEUR", L, y, 9.3, bold);
  text("CLIENT", L + 292, y, 9.3, bold);
  const colLines = (lines: string[], x: number, width: number) => {
    let yy = y - 14;
    lines.forEach((line, i) => {
      for (const part of wrap(line, i === 0 ? bold : regular, 9.3, width)) {
        text(part, x, yy, 9.3, i === 0 ? bold : regular);
        yy -= 12;
      }
    });
    return yy;
  };
  const yA = colLines(supplier, L, 270);
  const yB = colLines(buyer, L + 292, 240);
  const partyBottom = Math.min(yA, yB) + 6;
  page.drawLine({ start: { x: L + 276, y: y + 10 }, end: { x: L + 276, y: partyBottom }, thickness: 1, color: LINE });
  y = partyBottom - 16;

  // Dates.
  text(`Émise le ${formatDate(input.issuedOn)} | Révision du ${formatDate(input.issuedOn)} | Valide jusqu'au ${formatDate(input.validUntil)}`, L, y, 8, regular, SMALL);
  y -= 26;

  // Titre = nom du modèle.
  text(input.model.name.replace(/ \(ouverte\)$/, ""), L, y, 17, bold, NAVY);
  y -= 24;

  // DESCRIPTION DU MODÈLE : 2 colonnes lues de haut en bas, colonne de gauche d'abord.
  section("DESCRIPTION DU MODÈLE", y);
  y -= 22;
  const rows = descriptionRows(input.model, input.voltage);
  const half = Math.ceil(rows.length / 2);
  const left = rows.slice(0, half);
  const rightCol = rows.slice(half);
  const rowH = 17;
  const tableTop = y + 12;
  for (let i = 0; i < half; i++) {
    const yy = y - i * rowH;
    const [a, b] = left[i];
    text(a, L + 10, yy, 9.3, bold);
    text(b, L + 120, yy, 9.3);
    if (rightCol[i]) {
      const [cc, d] = rightCol[i];
      text(cc, L + 276, yy, 9.3, bold);
      text(d, L + 386, yy, 9.3);
    }
    if (i < half - 1) hline(yy - 5.5, L, R, 0.4);
  }
  page.drawLine({ start: { x: L + 266, y: tableTop }, end: { x: L + 266, y: y - (half - 1) * rowH - 6 }, thickness: 0.6, color: LINE });
  y -= half * rowH;

  // Autres détails confirmés, en un bloc.
  const extras: [string, string][] = [];
  if (input.model.dimensions) extras.push(["Dimensions", input.model.dimensions]);
  extras.push(["Préparation", "Huile et liquide de refroidissement Prestone inclus"]);
  extras.push(["Garantie", "1 an ou 1 500 heures, selon la première limite atteinte"]);
  let x = L + 10;
  const maxX = R - 10;
  for (const [i, [k, v]] of extras.entries()) {
    const parts: [string, PDFFont][] = [[k, bold], [` : ${v}`, regular], [i < extras.length - 1 ? "  ·  " : "", regular]];
    for (const [segment, font] of parts) {
      for (const word of segment.split(/(?<= )/)) {
        const w = font.widthOfTextAtSize(word, 8);
        if (x + w > maxX) {
          x = L + 10;
          y -= 10;
        }
        text(word, x, y, 8, font, SMALL);
        x += w;
      }
    }
  }
  y -= 26;

  // PRIX ET TAXES.
  section("PRIX ET TAXES", y);
  y -= 24;
  const totals = computeTotals(input.model.priceCad, input.quantity);
  const cQty = L + 272;
  const cUnit = L + 316;
  text("Description", L + 10, y, 9.3, bold);
  text("Qté", cQty, y, 9.3, bold);
  text("Prix unitaire", cUnit, y, 9.3, bold);
  right("Montant", R - 6, y, 9.3, bold);
  hline(y - 6);
  y -= 20;
  const itemName = input.model.name.replace(/ \(ouverte\)$/, "");
  text(itemName, L + 10, y, 9.3);
  text(String(input.quantity), cQty, y, 9.3);
  text(formatMoney(input.model.priceCad), cUnit, y, 9.3);
  right(formatMoney(totals.subtotal), R - 6, y, 9.3);
  hline(y - 7);
  y -= 26;

  // Conditions à gauche, totaux à droite. Le dépôt et la validité ne sont pas répétés ici.
  let yc = y;
  text("CONDITIONS", L + 10, yc, 9.3, bold);
  yc -= 14;
  QUOTE_CONDITIONS.forEach((condition, i) => {
    for (const line of wrap(`• ${condition}`, i === 0 ? bold : regular, 8, 250)) {
      text(line, L + 10, yc, 8, i === 0 ? bold : regular, SMALL);
      yc -= 10;
    }
  });
  yc -= 4;
  const linkLabel = input.model.key === "perkins-20-ouverte" ? "Modèles Perkins et photos" : "Voir la fiche et les photos en ligne";
  text(linkLabel, L + 10, yc, 8, regular, NAVY);
  const linkW = regular.widthOfTextAtSize(linkLabel, 8);
  page.drawLine({ start: { x: L + 10, y: yc - 1.5 }, end: { x: L + 10 + linkW, y: yc - 1.5 }, thickness: 0.4, color: NAVY });
  addLink(doc, page, input.model.url, L + 10, yc - 3, linkW, 11);

  const tx = R - 262;
  let yt = y;
  const sumRow = (label: string, value: string) => {
    text(label, tx + 6, yt, 9.3);
    right(value, R - 6, yt, 9.3);
    yt -= 18;
  };
  sumRow("Sous-total", formatMoney(totals.subtotal));
  sumRow("TPS (5 %)", formatMoney(totals.tps));
  sumRow("TVQ (9,975 %)", formatMoney(totals.tvq));
  page.drawRectangle({ x: tx, y: yt - 6, width: 262, height: 20, color: NAVY });
  text("TOTAL CAD", tx + 6, yt, 9.3, bold, WHITE);
  right(formatMoney(totals.total), R - 6, yt, 9.3, bold, WHITE);
  yt -= 26;
  page.drawRectangle({ x: tx, y: yt - 9, width: 262, height: 26, color: DEPOSIT });
  text("DÉPÔT REQUIS (30 %)", tx + 6, yt, 9.3, bold, WHITE);
  right(formatMoney(totals.deposit), R - 6, yt, 9.3, bold, WHITE);
  y = Math.min(yt - 30, yc - 24);

  // Acceptation du client.
  const boxTop = y + 12;
  const boxH = 62;
  page.drawRectangle({ x: L, y: boxTop - boxH, width: W, height: boxH, borderColor: LINE, borderWidth: 0.6 });
  text("ACCEPTATION DU CLIENT", L + 10, boxTop - 16, 9.3, bold);
  text("Nom :", L + 10, boxTop - 32, 8, regular, SMALL);
  text("Signature :", L + 210, boxTop - 32, 8, regular, SMALL);
  text("Date :", L + 410, boxTop - 32, 8, regular, SMALL);
  hline(boxTop - boxH + 8, L + 10, R - 10, 0.6, INK);
  y = boxTop - boxH - 16;
  text("Pour accepter, signez et retournez cette soumission par courriel.", L, y, 8, regular, SMALL);

  // Pied de page.
  hline(50);
  text(SUPPLIER.footer, L, 38, 7.5);
  text("Solution NRJ - Soumission commerciale", L, 25, 7.2);
  right("Page 1", R, 25, 7.2);

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
