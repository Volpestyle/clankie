// Keep the synchronous catalog API without reading the JSON at module import.
// A literal require also lets release bundlers retain this laziness in one file.
exports.loadBundledSnapshot = () => require("../data/models-dev-snapshot.json");
