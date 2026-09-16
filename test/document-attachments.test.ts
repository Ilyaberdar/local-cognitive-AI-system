import assert from "node:assert/strict";
import test from "node:test";
import { extractDocument } from "../src/utils/DocumentTextExtractor";

const url = (bytes: Buffer) => `data:application/octet-stream;base64,${bytes.toString("base64")}`;
const makePdf = (text: string) => {
  const stream = `BT /F1 12 Tf 30 100 Td (${text}) Tj ET`;
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let document = "%PDF-1.4\n", offsets = [0];
  objects.forEach((body, index) => { offsets.push(document.length); document += `${index + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = document.length;
  document += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(document);
};
const makeDocx = async (text: string): Promise<Buffer> => {
  const JSZip = require("jszip");
  const zip = new JSZip();
  zip.file("[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file("word/document.xml", `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`);
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
};

test("PDF and DOCX are actually parsed in workers and return their text", async () => {
  const pdf = await extractDocument("note.pdf", url(makePdf("Verification code: COBALT-742")));
  assert.match(pdf.textContent, /COBALT-742/);
  assert.equal(pdf.truncated, false);
  const docx = await extractDocument("note.docx", url(await makeDocx("Verification code: AMBER-529")));
  assert.equal(docx.textContent, "Verification code: AMBER-529");
  assert.equal(docx.truncated, false);
});

test("document limits are explicit; scans and legacy DOC cannot silently become metadata-only attachments", async () => {
  const result = await extractDocument("long.docx", url(await makeDocx("a".repeat(18000))));
  assert.equal(result.textContent.length, 12000);
  assert.equal(result.truncated, true);
  assert.match(result.warning!, /12,000/);
  await assert.rejects(extractDocument("scan.pdf", url(makePdf(""))), /No readable text/);
  await assert.rejects(extractDocument("old.doc", url(Buffer.from("sample"))), /Legacy/);
  await assert.rejects(extractDocument("broken.docx", url(Buffer.from("PK\x03\x04broken"))), /Invalid|unsupported/);
  await assert.rejects(extractDocument("fake.pdf", url(Buffer.from("not a PDF"))), /do not match/);
  const forged = await makeDocx("a".repeat(100000));
  const centralSignature = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
  for (let offset = forged.indexOf(centralSignature); offset >= 0; offset = forged.indexOf(centralSignature, offset + 4)) {
    if (forged.readUInt32LE(offset + 24) > 10000) forged.writeUInt32LE(4, offset + 24);
  }
  await assert.rejects(extractDocument("forged.docx", url(forged)), /larger than|size|Invalid/);
  const wrongCount = await makeDocx("hello");
  const end = wrongCount.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  wrongCount.writeUInt16LE(1, end + 8); wrongCount.writeUInt16LE(1, end + 10);
  await assert.rejects(extractDocument("hidden-entry.docx", url(wrongCount)), /Invalid|unsupported/);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(extractDocument("note.pdf", url(makePdf("hello")), abort.signal), /abort/i);
});
