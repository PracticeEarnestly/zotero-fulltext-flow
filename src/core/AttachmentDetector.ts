export async function localPDFAttachments(item: any): Promise<Array<{ attachment: any; path: string }>> {
  const attachmentIDs: number[] = item.getAttachments?.() || [];
  if (!attachmentIDs.length) return [];
  const rawAttachments = await Zotero.Items.getAsync(attachmentIDs as any);
  const attachments: any[] = Array.isArray(rawAttachments)
    ? rawAttachments
    : rawAttachments
      ? [rawAttachments]
      : [];
  const local: Array<{ attachment: any; path: string }> = [];
  for (const attachment of attachments) {
    if (!attachment || attachment.deleted) continue;
    const type = String(attachment.attachmentContentType || "").toLowerCase();
    const isPDF = attachment.isPDFAttachment?.() || type === "application/pdf";
    if (!isPDF) continue;
    try {
      const path = await attachment.getFilePathAsync?.();
      if (path && await IOUtils.exists(path)) local.push({ attachment, path });
    } catch (_) {
      // Missing/invalid file should be treated as missing full text.
    }
  }
  return local;
}

export async function hasUsablePDF(item: any): Promise<boolean> {
  return (await localPDFAttachments(item)).length > 0;
}
