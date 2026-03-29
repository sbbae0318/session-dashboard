/**
 * Lightweight Markdown → HTML renderer for assistant responses.
 * Supports: code blocks (with fold), inline code, headers, bold, italic,
 *           unordered/ordered lists, tables, links, horizontal rules.
 * No external dependencies.
 */

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function renderMarkdown(md: string): string {
  const lines = md.split('\n');
  const html: string[] = [];
  let i = 0;
  let listStack: ('ul' | 'ol')[] = [];

  function closeAllLists(): void {
    while (listStack.length > 0) {
      html.push(`</${listStack.pop()}>`);
    }
  }

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    const fenceMatch = line.match(/^```(\w*)/);
    if (fenceMatch) {
      closeAllLists();
      const lang = fenceMatch[1] || '';
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing ```
      const code = escapeHtml(codeLines.join('\n'));
      const lineCount = codeLines.length;
      const shouldFold = lineCount > 8;
      const langLabel = lang ? `<span class="code-lang">${escapeHtml(lang)}</span>` : '';
      if (shouldFold) {
        html.push(
          `<details class="code-fold"><summary class="code-fold-summary">${langLabel}<span class="code-fold-lines">${lineCount} lines</span></summary><pre class="code-block"><code>${code}</code></pre></details>`,
        );
      } else {
        html.push(`<div class="code-block-wrap">${langLabel}<pre class="code-block"><code>${code}</code></pre></div>`);
      }
      continue;
    }

    // Table (detect by |...|...|)
    if (line.includes('|') && line.trim().startsWith('|')) {
      closeAllLists();
      const tableLines: string[] = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim().startsWith('|')) {
        tableLines.push(lines[i]);
        i++;
      }
      html.push(renderTable(tableLines));
      continue;
    }

    // Empty line
    if (!line.trim()) {
      closeAllLists();
      i++;
      continue;
    }

    // Horizontal rule
    if (/^[-*_]{3,}\s*$/.test(line.trim())) {
      closeAllLists();
      html.push('<hr class="md-hr" />');
      i++;
      continue;
    }

    // Headers
    const headerMatch = line.match(/^(#{1,4})\s+(.+)/);
    if (headerMatch) {
      closeAllLists();
      const level = headerMatch[1].length;
      html.push(`<h${level + 2} class="md-h">${inlineFormat(headerMatch[2])}</h${level + 2}>`);
      i++;
      continue;
    }

    // Ordered list (1. 2. etc.)
    const olMatch = line.match(/^(\s*)\d+\.\s+(.+)/);
    if (olMatch) {
      if (listStack.length === 0 || listStack[listStack.length - 1] !== 'ol') {
        closeAllLists();
        html.push('<ol class="md-list">');
        listStack.push('ol');
      }
      html.push(`<li>${inlineFormat(olMatch[2])}</li>`);
      i++;
      continue;
    }

    // Unordered list (- or *)
    const ulMatch = line.match(/^(\s*)[-*]\s+(.+)/);
    if (ulMatch) {
      if (listStack.length === 0 || listStack[listStack.length - 1] !== 'ul') {
        closeAllLists();
        html.push('<ul class="md-list">');
        listStack.push('ul');
      }
      html.push(`<li>${inlineFormat(ulMatch[2])}</li>`);
      i++;
      continue;
    }

    // Regular paragraph
    closeAllLists();
    html.push(`<p class="md-p">${inlineFormat(line)}</p>`);
    i++;
  }

  closeAllLists();
  return html.join('\n');
}

function renderTable(lines: string[]): string {
  if (lines.length < 2) return lines.map(l => `<p class="md-p">${inlineFormat(l)}</p>`).join('\n');

  const parseCells = (line: string): string[] =>
    line.split('|').slice(1, -1).map(c => c.trim());

  const headers = parseCells(lines[0]);
  // Skip separator line (|---|---|)
  const startRow = /^[\s|:-]+$/.test(lines[1]) ? 2 : 1;
  const rows = lines.slice(startRow).map(parseCells);

  let out = '<div class="md-table-wrap"><table class="md-table"><thead><tr>';
  for (const h of headers) {
    out += `<th>${inlineFormat(h)}</th>`;
  }
  out += '</tr></thead><tbody>';
  for (const row of rows) {
    out += '<tr>';
    for (let j = 0; j < headers.length; j++) {
      out += `<td>${inlineFormat(row[j] ?? '')}</td>`;
    }
    out += '</tr>';
  }
  out += '</tbody></table></div>';
  return out;
}

function inlineFormat(text: string): string {
  let s = escapeHtml(text);
  // inline code (must come before bold/italic to avoid conflicts)
  s = s.replace(/`([^`]+)`/g, '<code class="md-inline-code">$1</code>');
  // links [text](url)
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a class="md-link" href="$2" target="_blank" rel="noopener">$1</a>');
  // bold
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // italic
  s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  return s;
}
