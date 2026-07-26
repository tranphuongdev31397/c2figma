const decode = value => value
  .replace(/&amp;/g, '&')
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'");

const clean = value => decode(value.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
const unique = values => [...new Set(values.filter(Boolean))];

function matches(html, pattern) {
  return [...html.matchAll(pattern)].map(match => clean(match[1]));
}

function extractHtmlSpec(html) {
  const source = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, '');
  const title = clean((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || ['', 'Untitled'])[1]);
  const tokens = {};
  for (const match of html.matchAll(/--([\w-]+)\s*:\s*([^;{}\n]+)/g)) tokens[match[1]] = match[2].trim();
  const headings = matches(source, /<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi);
  const labels = unique([
    ...matches(source, /<button[^>]*>([\s\S]*?)<\/button>/gi),
    ...matches(source, /<(?:label|summary)[^>]*>([\s\S]*?)<\/(?:label|summary)>/gi),
    ...[...source.matchAll(/<(?:div|span)[^>]*class=["'][^"']*(?:badge|status|chip)[^"']*["'][^>]*>([\s\S]*?)<\/(?:div|span)>/gi)].map(m => clean(m[1]))
  ]);
  return { title, tokens, headings: unique(headings), labels };
}

module.exports = { extractHtmlSpec };
