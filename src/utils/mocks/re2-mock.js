/**
 * Mock implementation of re2 native module for browser environments
 * This provides a JavaScript fallback using the standard RegExp
 */

class RE2 {
  constructor(pattern, options) {
    console.warn("Using RE2 mock in browser environment - falling back to standard RegExp");
    // Convert RE2 options to RegExp options
    let flags = "";
    if (options) {
      if (options.ignoreCase) flags += "i";
      if (options.multiline) flags += "m";
      if (options.global) flags += "g";
    }

    // Store the pattern for later use
    this.pattern = pattern;

    // Create a standard RegExp as fallback
    try {
      this.regexp = new RegExp(pattern, flags);
    } catch (e) {
      console.error("Failed to create RegExp from pattern:", pattern);
      this.regexp = new RegExp(".*"); // Match anything as fallback
    }
  }

  // Basic methods that re2 provides
  test(string) {
    return this.regexp.test(string);
  }

  exec(string) {
    return this.regexp.exec(string);
  }

  match(string) {
    return string.match(this.regexp);
  }

  replace(string, replacement) {
    return string.replace(this.regexp, replacement);
  }

  search(string) {
    return string.search(this.regexp);
  }

  // For getting named capture groups
  _getNamedCaptures(match, string) {
    if (!match) return null;

    // Extract named capture groups if available
    const groupNames = this.pattern.match(/\(\?<([^>]+)>/g);
    if (!groupNames) return match.groups || null;

    const groups = match.groups || {};
    groupNames.forEach((group, index) => {
      const name = group.replace(/\(\?<([^>]+)>.*/, "$1");
      groups[name] = match[index + 1];
    });

    return groups;
  }
}

// Export the RE2 class with the same interface as the native module
module.exports = RE2;

// Copy static properties
module.exports.ANCHOR_BOTH = 0;
module.exports.ANCHOR_END = 1;
module.exports.ANCHOR_NONE = 2;
module.exports.ANCHOR_START = 3;
module.exports.LITERAL = 0;
module.exports.MAX_MATCH = -1;
module.exports.UNANCHORED = 2;
