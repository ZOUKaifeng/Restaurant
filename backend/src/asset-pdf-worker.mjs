import { PDFArray, PDFDict, PDFDocument, PDFInvalidObject, PDFName, PDFStream } from 'pdf-lib';

// Dedicated short-lived parser process. Parent applies a wall-time and Node heap budget.
const blocked = new Set(['JavaScript', 'JS', 'OpenAction', 'AA', 'AcroForm', 'XFA', 'EmbeddedFiles', 'EmbeddedFile', 'Launch', 'RichMedia', 'RichMediaContent', 'RichMediaSettings', 'SubmitForm', 'ImportData', 'GoToR', 'GoToE', 'URI', 'Rendition', 'Movie', 'Sound', '3D', 'FileAttachment', 'Collection']);
process.once('message', async input => {
  let result = 'MALFORMED_FILE';
  try {
    if (typeof input !== 'string' || input.length > 28 * 1024 * 1024) throw new Error();
    const bytes = Buffer.from(input, 'base64');
    if (!bytes.length || bytes.length > 20 * 1024 * 1024) throw new Error();
    const document = await PDFDocument.load(bytes, { ignoreEncryption: false, throwOnInvalidObject: true, updateMetadata: false });
    if (document.isEncrypted || document.context.trailerInfo.Encrypt) result = 'ENCRYPTED_PDF';
    else if (document.getPageCount() < 1 || document.getPageCount() > 100) result = 'PDF_PAGE_LIMIT';
    else {
      const stack = [document.catalog, ...document.context.enumerateIndirectObjects().map(([, object]) => object)];
      const visited = new Set();
      result = 'OK';
      while (stack.length) {
        const object = stack.pop();
        if (visited.has(object)) continue;
        visited.add(object);
        if (visited.size > 200000) { result = 'PDF_COMPLEXITY_LIMIT'; break; }
        if (object instanceof PDFInvalidObject) { result = 'MALFORMED_FILE'; break; }
        if (object instanceof PDFName && blocked.has(object.decodeText())) { result = 'UNSAFE_PDF'; break; }
        if (object instanceof PDFStream) stack.push(object.dict);
        if (object instanceof PDFDict) {
          for (const [key, value] of object.entries()) {
            if (blocked.has(key.decodeText())) { result = 'UNSAFE_PDF'; break; }
            stack.push(value);
          }
          if (result !== 'OK') break;
        } else if (object instanceof PDFArray) stack.push(...object.asArray());
      }
    }
  } catch { result = 'MALFORMED_FILE'; }
  process.send?.({ result }, () => process.exit(0));
});
