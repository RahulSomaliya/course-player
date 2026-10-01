// Article lectures are course .html files rendered inline. They come off a disk, so they are sanitized
// (DOMPurify) before they touch the DOM; links open in a new tab so the course stays put.
import DOMPurify from 'dompurify';

let hooked = false;

function ensureHook(): void {
  if (hooked) return;
  hooked = true;
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node instanceof Element && node.tagName === 'A' && node.hasAttribute('href')) {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
  });
}

export function sanitizeArticle(html: string): string {
  ensureHook();
  const fragment = DOMPurify.sanitize(html, { RETURN_DOM_FRAGMENT: true, ADD_ATTR: ['target'] });
  // Udemy exports blank lines as <p><br></p>; the reading column has its own rhythm.
  for (const p of Array.from(fragment.querySelectorAll('p'))) {
    const onlyBreaks = p.textContent?.trim() === '' && Array.from(p.children).every((c) => c.tagName === 'BR');
    if (onlyBreaks && p.querySelector('img') === null) p.remove();
  }
  const box = document.createElement('div');
  box.append(fragment);
  return box.innerHTML;
}
