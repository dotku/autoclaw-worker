/** Map locale code to language instruction for AI prompts */
export function localeInstruction(locale?: string): string {
  const map: Record<string, string> = {
    zh: "IMPORTANT: You MUST respond entirely in Simplified Chinese (简体中文).",
    "zh-TW": "IMPORTANT: You MUST respond entirely in Traditional Chinese (繁體中文).",
    fr: "IMPORTANT: You MUST respond entirely in French (Français).",
    en: "",
  };
  return map[locale || "en"] || "";
}

/** Localized labels for task reports */
const LABELS: Record<string, Record<string, string>> = {
  en: {
    leadListBuilt: "Lead List Built",
    totalLeadsFound: "Total leads found",
    sourcesUsed: "Sources used",
    searchCriteria: "Search criteria (from KB)",
    industries: "Industries",
    jobTitles: "Job titles",
    keywords: "Keywords",
    domainsSearched: "Domains searched",
    errors: "Errors",
    none: "none",
    noDataSources: "No lead data sources configured. Add Apollo, Hunter, Snov, or Apify API keys in Settings → BYOK.",
    noLeadsFound: "No leads found",
    foundLeads: "Found {count} leads from {sources} sources",
    dataSourceVerification: "Data Source Verification",
    readyToUse: "Ready to use",
    noDataSourcesAvailable: "No data sources available. Add at least one API key (Apollo, Hunter, or Snov) in Settings → BYOK.",
    noDomains: "No target domains configured. Resolve the blocker first by providing target domains.",
  },
  zh: {
    leadListBuilt: "潜客列表已构建",
    totalLeadsFound: "找到潜客总数",
    sourcesUsed: "使用的数据源",
    searchCriteria: "搜索条件（来自知识库）",
    industries: "目标行业",
    jobTitles: "目标职位",
    keywords: "关键词",
    domainsSearched: "搜索的域名",
    errors: "错误",
    none: "无",
    noDataSources: "未配置潜客数据源。请在 设置 → Market 中添加 Apollo、Hunter、Snov 或 Apify API 密钥。",
    noLeadsFound: "未找到潜客",
    foundLeads: "从 {sources} 个数据源找到 {count} 个潜客",
    dataSourceVerification: "数据源验证",
    readyToUse: "可用",
    noDataSourcesAvailable: "无可用数据源。请在 设置 → Market 中添加至少一个 API 密钥（Apollo、Hunter 或 Snov）。",
    noDomains: "未配置目标域名。请先提供目标域名以解除阻塞。",
  },
  "zh-TW": {
    leadListBuilt: "潛客列表已建立",
    totalLeadsFound: "找到潛客總數",
    sourcesUsed: "使用的資料來源",
    searchCriteria: "搜尋條件（來自知識庫）",
    industries: "目標產業",
    jobTitles: "目標職位",
    keywords: "關鍵字",
    domainsSearched: "搜尋的網域",
    errors: "錯誤",
    none: "無",
    noDataSources: "未設定潛客資料來源。請在 設定 → Market 中新增 Apollo、Hunter、Snov 或 Apify API 金鑰。",
    noLeadsFound: "未找到潛客",
    foundLeads: "從 {sources} 個資料來源找到 {count} 個潛客",
    dataSourceVerification: "資料來源驗證",
    readyToUse: "可用",
    noDataSourcesAvailable: "無可用資料來源。請在 設定 → Market 中新增至少一個 API 金鑰（Apollo、Hunter 或 Snov）。",
    noDomains: "未設定目標網域。請先提供目標網域以解除封鎖。",
  },
  fr: {
    leadListBuilt: "Liste de prospects construite",
    totalLeadsFound: "Total de prospects trouvés",
    sourcesUsed: "Sources utilisées",
    searchCriteria: "Critères de recherche (depuis la KB)",
    industries: "Industries",
    jobTitles: "Titres de poste",
    keywords: "Mots-clés",
    domainsSearched: "Domaines recherchés",
    errors: "Erreurs",
    none: "aucun",
    noDataSources: "Aucune source de données configurée. Ajoutez une clé API Apollo, Hunter, Snov ou Apify dans Paramètres → Market.",
    noLeadsFound: "Aucun prospect trouvé",
    foundLeads: "{count} prospects trouvés depuis {sources} sources",
    dataSourceVerification: "Vérification des sources de données",
    readyToUse: "Prêt à utiliser",
    noDataSourcesAvailable: "Aucune source de données disponible. Ajoutez au moins une clé API (Apollo, Hunter ou Snov) dans Paramètres → Market.",
    noDomains: "Aucun domaine cible configuré. Résolvez d'abord le blocage en fournissant des domaines cibles.",
  },
};

export function t(locale: string | undefined, key: string): string {
  const lang = LABELS[locale || "en"] || LABELS.en;
  return lang[key] || LABELS.en[key] || key;
}
