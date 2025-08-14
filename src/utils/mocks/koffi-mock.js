/**
 * Mock implementation of koffi for browser environments
 * This provides stub implementations of the methods used by the attestor-core package
 */

// Create a stub library object
const createLibraryStub = () => {
  return {
    func: () => () => {
      console.warn("Koffi native function called in browser environment - stubbed implementation");
      return null;
    },
  };
};

// Main exports of the koffi module
module.exports = {
  // Main function to load a library
  load: function () {
    console.warn("Koffi.load called in browser environment - returning stub implementation");
    return createLibraryStub();
  },

  // Pointer type constructor
  pointer: function () {
    return null;
  },

  // Types that koffi exposes
  types: {
    void: "void",
    bool: "bool",
    char: "char",
    short: "short",
    int: "int",
    long: "long",
    float: "float",
    double: "double",
    pointer: "pointer",
    string: "string",
    buffer: "buffer",
  },

  // Other koffi utilities that might be used
  opaque: () => ({}),
  struct: () => ({}),
  union: () => ({}),
  array: () => [],

  // For handling callbacks
  register: () => () => {},
  unregister: () => {},
};
