/**
 * Lightweight Markdown → HTML renderer for assistant responses.
 * Supports: code blocks (with fold), inline code, headers, bold, italic, lists, paragraphs.
 * No external dependencies.
 */

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function renderMarkdown(md: string): string {
  const lines = md.split('\n');
  const html: string[] = [];
  let i = 0;
  let inList = false;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    const fenceMatch = line.match(/^```(\w*)/);
    if (fenceMatch) {
      if (inList) { html.push('</ul>'); inList = false; }
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

    // Empty line → close list, add spacing
    if (!line.trim()) {
      if (inList) { html.push('</ul>'); inList = false; }
      i++;
      continue;
    }

    // Headers
    const headerMatch = line.match(/^(#{1,3})\s+(.+)/);
    if (headerMatch) {
      if (inList) { html.push('</ul>'); inList = false; }
      const level = headerMatch[1].length;
      html.push(`<h${level + 2} class="md-h">${inlineFormat(headerMatch[2])}</h${level + 2}>`);
      i++;
      continue;
    }

    // List items (- or *)
    const listMatch = line.match(/^[\s]*[-*]\s+(.+)/);
    if (listMatch) {
      if (!inList) { html.push('<ul class="md-list">'); inList = true; }
      html.push(`<li>${inlineFormat(listMatch[1])}</li>`);
      i++;
      continue;
    }

    // Regular paragraph
    if (inList) { html.push('</ul>'); inList = false; }
    html.push(`<p class="md-p">${inlineFormat(line)}</p>`);
    i++;
  }

  if (inList) html.push('</ul>');
  return html.join('\n');
}

function inlineFormat(text: string): string {
  let s = escapeHtml(text);
  // inline code
  s = s.replace(/`([^`]+)`/g, '<code class="md-inline-code">$1</code>');
  // bold
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // italic
  s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  return s;
}
