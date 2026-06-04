function normalizeXmlValue(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

export function escapeXml(value) {
  return normalizeXmlValue(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function xmlTag(name, value) {
  return `<${name}>${escapeXml(value)}</${name}>`;
}

// VERIFY against ?singleWsdl: this namespace string is the single most
// important thing to confirm. tempuri.org was definitely wrong; the Kareo
// 2.1 service contract namespace is below per the published schema.
export const TEBRA_NAMESPACE = 'http://www.kareo.com/api/schemas/';

export function buildSoapEnvelope(action, bodyXml, namespace = TEBRA_NAMESPACE) {
  return `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"
               xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
  <soap:Body>
    <${action} xmlns="${namespace}">
      ${bodyXml}
    </${action}>
  </soap:Body>
</soap:Envelope>`;
}