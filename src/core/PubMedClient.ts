import { PREF_PREFIX } from "../config";

export type PubMedAuthor = {
  lastName: string;
  firstName: string;
  initials: string;
  collectiveName: string;
};

export type PubMedSummary = {
  pmid: string;
  title: string;
  authors: string[];
  structuredAuthors: PubMedAuthor[];
  journal: string;
  journalAbbr: string;
  year: string;
  pubDate: string;
  volume: string;
  issue: string;
  pages: string;
  doi: string;
};

export type PubMedIdentifiers = {
  pmid: string;
  pmcid: string;
  doi: string;
};

export class PubMedClient {
  private static requestChain: Promise<unknown> = Promise.resolve();
  private static lastRequestAt = 0;

  private static ncbiParams(): string {
    const params = new URLSearchParams();
    params.set("tool", "FullTextFlow");
    const email = String(Zotero.Prefs.get(`${PREF_PREFIX}.ncbiEmail`) || "").trim();
    if (email) params.set("email", email);
    return params.toString();
  }

  private static async text(url: string, accept = "application/json"): Promise<string> {
    const task = async () => {
      const elapsed = Date.now() - this.lastRequestAt;
      if (elapsed < 350) await new Promise(resolve => setTimeout(resolve, 350 - elapsed));
      this.lastRequestAt = Date.now();
      const response = await Zotero.HTTP.request("GET", url, {
        responseType: "text",
        successCodes: false,
        timeout: 30000,
        headers: { Accept: accept }
      });
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`NCBI request failed: HTTP ${response.status}`);
      }
      return String(response.responseText || "");
    };
    const pending = this.requestChain.then(task, task);
    this.requestChain = pending.then(() => undefined, () => undefined);
    return pending;
  }

  private static async json(url: string): Promise<any> {
    const raw = await this.text(url, "application/json");
    try { return JSON.parse(raw || "{}"); }
    catch (_) { throw new Error("NCBI returned invalid JSON."); }
  }

  static async findPMIDByDOI(doi: string): Promise<string> {
    const clean = normalizePubMedDOI(doi);
    if (!clean) return "";
    const params = new URLSearchParams({ db: "pubmed", term: `${clean}[AID]`, retmode: "json", retmax: "5" });
    const data = await this.json(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?${params.toString()}&${this.ncbiParams()}`);
    const ids = Array.isArray(data?.esearchresult?.idlist) ? data.esearchresult.idlist.map(String) : [];
    if (ids.length !== 1) return "";
    return /^\d+$/.test(ids[0]) ? ids[0] : "";
  }

  static async resolvePMCIdentifiers(id: string): Promise<PubMedIdentifiers> {
    const clean = String(id || "").trim();
    if (!clean) return { pmid: "", pmcid: "", doi: "" };
    const params = new URLSearchParams({ ids: clean, format: "json" });
    const data = await this.json(`https://pmc.ncbi.nlm.nih.gov/tools/idconv/api/v1/articles/?${params.toString()}&${this.ncbiParams()}`);
    const record = Array.isArray(data?.records) ? data.records[0] : null;
    if (!record || record.error) return { pmid: "", pmcid: "", doi: "" };
    return {
      pmid: record.pmid ? String(record.pmid) : "",
      pmcid: record.pmcid ? String(record.pmcid).toUpperCase() : "",
      doi: record.doi ? normalizePubMedDOI(String(record.doi)) : ""
    };
  }

  static async fetchSummary(pmid: string): Promise<PubMedSummary | null> {
    const clean = String(pmid || "").trim();
    if (!/^\d+$/.test(clean)) return null;
    const params = new URLSearchParams({ db: "pubmed", id: clean, retmode: "json", version: "2.0" });
    const data = await this.json(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?${params.toString()}&${this.ncbiParams()}`);
    const row = data?.result?.[clean];
    if (!row || row.error) return null;
    const articleIDs = Array.isArray(row.articleids) ? row.articleids : [];
    const doi = articleIDs.find((x: any) => String(x?.idtype || "").toLowerCase() === "doi")?.value || "";
    const pubDate = String(row.pubdate || row.epubdate || "").trim();
    const year = pubDate.match(/\b(18|19|20|21)\d{2}\b/)?.[0] || "";
    const structuredAuthors = await this.fetchStructuredAuthors(clean);
    return {
      pmid: clean,
      title: decodeHTML(String(row.title || "")),
      authors: Array.isArray(row.authors) ? row.authors.map((x: any) => String(x?.name || "")).filter(Boolean) : [],
      structuredAuthors,
      journal: String(row.fulljournalname || ""),
      journalAbbr: String(row.source || ""),
      year,
      pubDate,
      volume: String(row.volume || ""),
      issue: String(row.issue || ""),
      pages: String(row.pages || row.elocationid || ""),
      doi: normalizePubMedDOI(String(doi || ""))
    };
  }

  private static async fetchStructuredAuthors(pmid: string): Promise<PubMedAuthor[]> {
    const params = new URLSearchParams({ db: "pubmed", id: pmid, retmode: "xml" });
    const xml = await this.text(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?${params.toString()}&${this.ncbiParams()}`, "application/xml,text/xml");
    try {
      const doc = new DOMParser().parseFromString(xml, "application/xml");
      const nodes = Array.from(doc.querySelectorAll("PubmedArticle Article AuthorList > Author"));
      return nodes.map((node: any) => ({
        lastName: String(node.querySelector("LastName")?.textContent || "").trim(),
        firstName: String(node.querySelector("ForeName")?.textContent || "").trim(),
        initials: String(node.querySelector("Initials")?.textContent || "").trim(),
        collectiveName: String(node.querySelector("CollectiveName")?.textContent || "").trim()
      })).filter((x: PubMedAuthor) => x.lastName || x.collectiveName);
    } catch (_) {
      return [];
    }
  }
}

export function normalizePubMedDOI(value: string): string {
  return String(value || "").trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").replace(/^doi\s*:\s*/i, "").trim().toLowerCase();
}

function decodeHTML(value: string): string {
  const text = String(value || "");
  try {
    const doc = new DOMParser().parseFromString(`<body>${text}</body>`, "text/html");
    return String(doc.body?.textContent || text).trim();
  } catch (_) {
    return text.replace(/<[^>]+>/g, "").trim();
  }
}
