const test = require('node:test');
const assert = require('node:assert/strict');
const { extractHtmlSpec } = require('../src/extract-html');

test('extracts a reusable visual spec from standalone HTML', () => {
  const html = `
    <html><head><title>Nhân viên</title></head>
    <style>:root { --primary: #16993B; --radius: 10px; }</style>
    <body><h1>Nhân viên</h1><h2>Danh sách nhân viên</h2>
      <button>Thêm nhân viên</button><div class="badge">Đang hoạt động</div>
    </body></html>`;

  assert.deepEqual(extractHtmlSpec(html), {
    title: 'Nhân viên',
    tokens: { primary: '#16993B', radius: '10px' },
    headings: ['Nhân viên', 'Danh sách nhân viên'],
    labels: ['Thêm nhân viên', 'Đang hoạt động']
  });
});
