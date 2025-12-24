
// Verification script for product logging and search
import { searchProducts } from "./utils/productSearcher.js";

// Mock products
const mockProducts = [
    {
        id: "1",
        name: "Microsoft SQL Server 2022 Standard",
        vendor: "Microsoft",
        category: "Software",
        description: "Relational database management system",
        tags: ["database", "sql", "server"]
    },
    {
        id: "2",
        name: "Windows 365 Business",
        vendor: "Microsoft",
        category: "Cloud",
        tags: ["cloud", "windows", "desktop"]
    }
];

// Test Logging Logic (Simulated)
console.log("--- Testing SQL Product Logging (Simulation) ---");
const sqlProducts = mockProducts.filter(p =>
    (p.name || '').toLowerCase().includes('sql') ||
    (p.description || '').toLowerCase().includes('sql')
);

if (sqlProducts.length > 0) {
    console.log(`✅ SQL Products found in mock data: ${sqlProducts.length}`);
} else {
    console.log("❌ SQL Products NOT found in mock data");
}

// Test Search Logic
console.log("\n--- Testing Search Logic for 'sql products' ---");
const query = "sql"; // server.js would clean 'sql products' to 'sql'
const results = searchProducts(query, mockProducts);

if (results.length > 0) {
    console.log(`✅ Search returned ${results.length} results for '${query}'`);
    results.forEach(r => {
        console.log(`   - ${r.name} (Score: ${r._matchScore.toFixed(2)})`);
    });
} else {
    console.log(`❌ Search returned NO results for '${query}'`);
}
