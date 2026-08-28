#!/usr/bin/env python3
from pathlib import Path

p = Path('README.md')
text = p.read_text()
text = text.replace('**Current preview: 0.2.5**', '**Current preview: 0.2.7**')
text = text.replace('## Current version: 0.2.5 Preview', '## Current version: 0.2.7 Preview')
text = text.replace(
    "You choose which Zotero Collections deserve complete full text. FullTextFlow scans only those Collections, skips items that already have usable PDFs, asks Zotero's own **Find Full Text** machinery first, and uses JLSS / 聚联医疗 as a fallback when Zotero cannot obtain the file.",
    "You choose which Zotero Collections deserve complete full text. FullTextFlow scans only those Collections, skips items that already have usable PDFs, and follows the selected global retrieval strategy. Starting with 0.2.7, the default is **全部使用聚联**: items missing a usable local PDF are sent directly to JLSS, while Zotero-first and fallback modes remain available."
)
text = text.replace(
    '''Selected Zotero Collection
  -> scan regular items
  -> skip usable local PDFs
  -> Zotero Find Full Text
       -> DOI / URL / OA / custom resolvers
  -> if still missing: JLSS / 聚联医疗
  -> persistent background queue
''',
    '''Selected Zotero Collection
  -> scan regular items
  -> skip usable local PDFs
  -> apply selected retrieval strategy
       -> default: JLSS / 聚联医疗 directly
       -> optional: JLSS -> Zotero fallback
       -> optional: Zotero -> JLSS fallback
       -> optional: Zotero only
  -> persistent background queue
'''
)
text = text.replace(
    '''- Try Zotero's built-in file resolvers first: DOI, URL, Open Access, and configured custom resolvers.
- Fall back to JLSS / 聚联医疗 only when Zotero does not find a file.
''',
    '''- Choose one of four global Zotero/JLSS retrieval strategies; **全部使用聚联** is the 0.2.7 default.
- Keep Zotero-first, JLSS-first-with-Zotero-fallback, and Zotero-only modes available as alternatives.
'''
)
text = text.replace(
    '''## Retrieval order

By default:

1. Existing local PDF → skip.
2. Zotero Find Full Text → DOI / URL / OA / custom resolver.
3. JLSS / 聚联医疗 fallback.
4. Remote task diagnosis and polling.
5. PDF verification.
6. Attach to the original item.

This reduces unnecessary JLSS requests and preserves your institution's delivery quota.
''',
    '''## Retrieval order

The order depends on the selected strategy. With the 0.2.7 default (**全部使用聚联**):

1. Existing usable local PDF → skip.
2. Submit directly to JLSS / 聚联医疗.
3. Remote task diagnosis and polling.
4. Download and verify the returned PDF.
5. Attach it to the original Zotero item.

Alternative modes can place Zotero Find Full Text before JLSS, use Zotero only, or use Zotero strictly as a fallback after a JLSS failure.
'''
)
p.write_text(text)
