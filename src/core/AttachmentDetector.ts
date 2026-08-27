export async function hasUsablePDF(item: any): Promise<boolean> {
  const attachmentIDs: number[] = item.getAttachments?.() || [];
  if (!attachmentIDs.length) return false;
  const attachments = await Zotero.Items.getAsync(attachmentIDs as any);
  for (const attachment of attachments as any[]) {
    if (!attachment) continue;
    const type = String(attachment.attachmentContentType || "").toLowerCase();
    const isPDF = attachment.isPDFAttachment?.() || type === "application/pdf";
    if (!isPDF) continue;
    try {
      const path = await attachment.getFilePathAsync?.();
      if (path && await IOUtils.exists(path)) return true;
    } catch (_) {
      // Missing/invalid file should be treated as missing full text.
    }
  }
  return false;
}
