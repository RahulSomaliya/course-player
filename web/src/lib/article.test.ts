// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { sanitizeArticle } from './article';

describe('sanitizeArticle', () => {
  it('keeps the content and opens links in a new tab', () => {
    const out = sanitizeArticle('<h4><strong>Hi</strong></h4><p><a href="https://github.com/x">repo</a></p>');
    expect(out).toContain('<strong>Hi</strong>');
    const a = new DOMParser().parseFromString(out, 'text/html').querySelector('a');
    expect(a?.getAttribute('href')).toBe('https://github.com/x');
    expect(a?.getAttribute('target')).toBe('_blank');
    expect(a?.getAttribute('rel')).toBe('noopener noreferrer');
  });
  it('strips scripts, handlers and javascript: urls', () => {
    const out = sanitizeArticle('<p onclick="x()">t</p><script>alert(1)</script><a href="javascript:alert(1)">x</a>');
    expect(out).not.toContain('script');
    expect(out).not.toContain('onclick');
    expect(out).not.toContain('javascript:');
  });
  it('drops the empty spacer paragraphs Udemy exports (<p><br></p>)', () => {
    expect(sanitizeArticle('<p>a</p><p><br></p><p>b</p>')).toBe('<p>a</p><p>b</p>');
  });
});
