export interface PdfFonts {
  regular: string;
  bold: string;
}

let cache: Promise<PdfFonts> | null = null;

async function b64(url: string): Promise<string> {
  const buf = new Uint8Array(await (await fetch(url)).arrayBuffer());
  let s = '';
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(s);
}

/** DejaVu Sans (has ç ğ ı İ ö ş ü), base64 for jsPDF. */
export function loadPdfFonts(): Promise<PdfFonts> {
  const base = import.meta.env.BASE_URL;
  cache ??= Promise.all([b64(`${base}fonts/DejaVuSans.ttf`), b64(`${base}fonts/DejaVuSans-Bold.ttf`)]).then(
    ([regular, bold]) => ({ regular, bold }),
  );
  return cache;
}
