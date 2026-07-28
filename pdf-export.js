import dompdf from "dompdf.js";

export function renderArticlePdf(element, options = {}) {
  return dompdf(element, {
    pagination: true,
    format: "a4",
    orientation: "p",
    backgroundColor: "#ffffff",
    useCORS: true,
    logging: false,
    compress: true,
    putOnlyUsedFonts: true,
    windowWidth: 794,
    pageConfig: {
      header: {
        content: "Readability Reader",
        height: 36,
        contentColor: "#687872",
        contentFontSize: 9,
        contentPosition: "centerLeft",
        padding: [0, 48, 0, 48],
      },
      footer: {
        content: "Page ${currentPage} / ${totalPages}",
        height: 36,
        contentColor: "#687872",
        contentFontSize: 9,
        contentPosition: "centerRight",
        padding: [0, 48, 0, 48],
      },
    },
    ...options,
  });
}
