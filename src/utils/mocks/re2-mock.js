export default function regularRegex(pattern, flags) {
  flags = flags?.replace("u", ""); // remove unicode flag if present
  return new RegExp(pattern, flags);
}
