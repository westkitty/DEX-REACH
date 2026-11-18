import test from 'node:test';
import assert from 'node:assert/strict';

// The native renderer is a standalone JavaScript compatibility module.
const rendererUrl = new URL('../src/node/compat-runtime/runtime/tools/pdf/markdown-render.js', import.meta.url);
const { markdownToSafeHtml } = await import(rendererUrl.href);

test('Markdown PDF rendering suppresses zero-delay navigation and active raw HTML', () => {
  const source = '# Native PDF\n\nRetained PDF text.\n\n'
    + '<meta http-equiv="refresh" content="0;url=http://127.0.0.1:49112/navigation">\n'
    + '<script>fetch("http://127.0.0.1:49112/script")</script>\n'
    + '<iframe src="file:///tmp/nonexistent-secret"></iframe>\n'
    + '<style>@import url(http://127.0.0.1:49112/css)</style>\n'
    + '<img src="http://127.0.0.1:49112/image">\n';
  const html: string = markdownToSafeHtml(source);
  assert.match(html, /<h1[^>]*>Native PDF<\/h1>/);
  assert.match(html, /Retained PDF text\./);
  assert.doesNotMatch(html, /<\s*(meta|script|iframe|style|img)\b/i);
  assert.doesNotMatch(html, /http-equiv|javascript:|\/navigation|\/script|\/css|\/image/i);
});

test('case variants of raw tags cannot trigger a refresh or load a resource', () => {
  const source = '## Source\n\n<META HTTP-EQUIV="refresh" CONTENT="0;URL=https://example.invalid/evil">\n'
    + '<IFRAME SRC="https://example.invalid/nested"></IFRAME>\n'
    + '<img src="file:///private/secret">\n';
  const html: string = markdownToSafeHtml(source);
  assert.match(html, /Source/);
  assert.doesNotMatch(html, /<\s*(meta|iframe|img)\b/i);
  assert.doesNotMatch(html, /example\.invalid|file:\/\/\/private\/secret/i);
});

test('ordinary Markdown headings, bold, and emphasis remain intact', () => {
  const html: string = markdownToSafeHtml('# Header\n\n**Important** and *emphasis*.');
  assert.match(html, /<h1[^>]*>Header<\/h1>/);
  assert.match(html, /<strong>Important<\/strong>/);
  assert.match(html, /<em>emphasis<\/em>/);
});
