const GEO_SERVICES = [
  {
    url: "https://api.country.is",
    extract: (data) => data?.country,
  },
  {
    url: "https://ipwho.is/",
    extract: (data) => data?.country_code,
  },
  {
    url: "https://ipapi.co/json/",
    extract: (data) => data?.country_code,
  },
];

export const getUserLocationBasedOnIp = async () => {
  for (const service of GEO_SERVICES) {
    try {
      const response = await fetch(service.url);
      if (!response.ok) continue;
      const contentType = response.headers.get("content-type") || "";
      if (!contentType.includes("application/json")) continue;
      const data = await response.json();
      const code = service.extract(data);
      if (code && typeof code === "string" && code.length === 2) {
        return code;
      }
    } catch {
      // Try next service
    }
  }
  return "";
};
