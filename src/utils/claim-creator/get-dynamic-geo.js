export const getUserLocationBasedOnIp = async () => {
  try {
    const response = await fetch("https://ipapi.co/json/");
    const data = await response.json();

    if (response?.status !== 200) {
      throw new Error("Failed to get user location based on IP");
    }

    const countryCode = data?.["country_code"] ?? "US";
    return countryCode;
  } catch (error) {
    console.error("Error getting user location based on IP:", error);
    return "US"; // default to US if error
  }
};
