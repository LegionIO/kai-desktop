const MAX_BROWSER_ACCESSIBLE_NAME_SOURCE_CHARS = 4_096;

/**
 * Shared page-world helpers used by both browser inspection and semantic
 * action targeting. Keeping the generated source in one place makes the
 * element names shown to the model match the names accepted by actions.
 */
export function browserSemanticHelpersExpression(): string {
  return `
    const normalizeSemanticText = (value) => {
      let text = '';
      try { text = value == null ? '' : String(value); } catch { return ''; }
      return text.replace(/\\s+/g, ' ').trim().slice(0, ${MAX_BROWSER_ACCESSIBLE_NAME_SOURCE_CHARS});
    };
    const semanticTextWithin = (node) => {
      if (!node) return '';
      let text = '';
      try { text = typeof node.innerText === 'string' ? node.innerText : node.textContent; } catch {}
      return normalizeSemanticText(text);
    };
    const semanticContentsName = (node) => {
      const text = semanticTextWithin(node);
      if (text) return text;
      try {
        return normalizeSemanticText(
          Array.from(node.querySelectorAll?.('img[alt],input[type="image"][alt]') || [])
            .slice(0, 64)
            .map((image) => normalizeSemanticText(image.alt || image.getAttribute?.('alt')))
            .filter(Boolean)
            .join(' '),
        );
      } catch { return ''; }
    };
    const roleFor = (el) => {
      const explicitRole = normalizeSemanticText(el.getAttribute?.('role')).split(' ')[0];
      if (explicitRole) return explicitRole.toLowerCase();
      const tagName = normalizeSemanticText(el.tagName).toUpperCase();
      if (tagName === 'A' && el.hasAttribute?.('href')) return 'link';
      if (tagName === 'BUTTON') return 'button';
      if (tagName === 'TEXTAREA') return 'textbox';
      if (tagName === 'SELECT') {
        const size = Number(el.size);
        return el.multiple || (Number.isFinite(size) && size > 1) ? 'listbox' : 'combobox';
      }
      if (tagName === 'INPUT') {
        const type = normalizeSemanticText(el.type || el.getAttribute?.('type') || 'text').toLowerCase();
        if (type === 'checkbox') return 'checkbox';
        if (type === 'radio') return 'radio';
        if (type === 'range') return 'slider';
        if (type === 'number') return 'spinbutton';
        if (type === 'button' || type === 'submit' || type === 'reset' || type === 'image' || type === 'file') {
          return 'button';
        }
        if (type === 'hidden') return undefined;
        return 'textbox';
      }
      return undefined;
    };
    const accessibleNameFor = (el) => {
      const labelledBy = normalizeSemanticText(el.getAttribute?.('aria-labelledby'));
      if (labelledBy) {
        const referenced = labelledBy
          .split(' ')
          .slice(0, 64)
          .map((id) => {
            try { return semanticTextWithin(document.getElementById(id)); } catch { return ''; }
          })
          .filter(Boolean)
          .join(' ');
        if (referenced) return normalizeSemanticText(referenced);
      }
      const ariaLabel = normalizeSemanticText(el.getAttribute?.('aria-label'));
      if (ariaLabel) return ariaLabel;

      const labelTexts = [];
      try {
        if (el.labels) {
          for (const label of Array.from(el.labels).slice(0, 64)) {
            const labelText = semanticTextWithin(label);
            if (labelText) labelTexts.push(labelText);
          }
        }
      } catch {}
      if (labelTexts.length === 0) {
        let ancestor = el.parentElement;
        for (let depth = 0; ancestor && depth < 64; depth += 1, ancestor = ancestor.parentElement) {
          if (normalizeSemanticText(ancestor.tagName).toUpperCase() !== 'LABEL') continue;
          const labelText = semanticTextWithin(ancestor);
          if (labelText) labelTexts.push(labelText);
          break;
        }
      }
      if (labelTexts.length > 0) return normalizeSemanticText(labelTexts.join(' '));

      const tagName = normalizeSemanticText(el.tagName).toUpperCase();
      const type = normalizeSemanticText(el.type || el.getAttribute?.('type')).toLowerCase();
      if (tagName === 'INPUT' && type === 'image') {
        const alt = normalizeSemanticText(el.alt || el.getAttribute?.('alt'));
        if (alt) return alt;
      }
      if (tagName === 'INPUT' && ['button', 'submit', 'reset', 'image'].includes(type)) {
        const value = normalizeSemanticText(el.value || el.getAttribute?.('value'));
        if (value) return value;
      }
      if (tagName === 'BUTTON') {
        const text = semanticContentsName(el);
        if (text) return text;
        const value = normalizeSemanticText(el.value || el.getAttribute?.('value'));
        if (value) return value;
      }
      if (tagName === 'IMG') {
        const alt = normalizeSemanticText(el.alt || el.getAttribute?.('alt'));
        if (alt) return alt;
      }
      const contents = semanticContentsName(el);
      if (contents) return contents;
      const title = normalizeSemanticText(el.getAttribute?.('title'));
      if (title) return title;
      return normalizeSemanticText(el.getAttribute?.('placeholder'));
    };
  `;
}
