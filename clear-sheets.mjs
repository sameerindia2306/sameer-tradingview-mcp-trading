import { google } from "googleapis";
import { Buffer } from "buffer";

const SHEET_ID = "1eMxYzJ8f2gzOA82Jtjoz6AxH3d7mvyd_oQEtLiYTLE8";
const CREDS_B64 = process.env.GOOGLE_CREDENTIALS_B64;

const credentials = JSON.parse(Buffer.from(CREDS_B64, "base64").toString("utf8"));
const auth = new google.auth.GoogleAuth({ credentials, scopes: ["https://www.googleapis.com/auth/spreadsheets"] });
const sheets = google.sheets({ version: "v4", auth: await auth.getClient() });

const HEADERS = ["Date","Time (UTC)","Broker","Symbol","Asset Class","Side","Quantity","Entry Price","Total USD","Fee (est.)","Order ID","Mode","Status","Exit Price","Exit Time","P&L USD","P&L %","Notes"];
const TABS = ["Gold", "Tech Stocks", "Forex"];

for (const tab of TABS) {
  try {
    await sheets.spreadsheets.values.clear({ spreadsheetId: SHEET_ID, range: `${tab}!A:R` });
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID, range: `${tab}!A1`,
      valueInputOption: "RAW", requestBody: { values: [HEADERS] },
    });
    console.log(`✅ Cleared ${tab}`);
  } catch (e) {
    console.log(`⚠️  ${tab}: ${e.message}`);
  }
}
console.log("Done.");
