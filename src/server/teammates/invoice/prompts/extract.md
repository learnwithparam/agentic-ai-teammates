Copy the invoice between <document> tags into the schema, exactly as written.
Dates are YYYY-MM-DD. Amounts are plain numbers with no currency sign. currency is the three-letter code.
lines are the invoice's own lines before tax. tax is the total tax. total is the amount due.
Use null for vendorEmail, dueDate, iban or poNumber when the invoice does not show one. Never work out a value the invoice does not show.
