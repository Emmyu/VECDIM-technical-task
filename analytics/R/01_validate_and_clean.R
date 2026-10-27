# =====================================================================
# Step 1: data-quality validation and cleaning
# Reads the raw CSV, applies validate_records(), writes flags + cleaned data.
# Run from the pack's root folder:
#   Rscript R/01_validate_and_clean.R data/vecdim_dummy_entomology_data.csv outputs
# =====================================================================
source("R/helpers.R")
if (!exists("in_file")) {
  a <- commandArgs(trailingOnly = TRUE)
  in_file <- if (length(a) >= 1) a[1] else "data/vecdim_dummy_entomology_data.csv"
  out_dir <- if (length(a) >= 2) a[2] else "outputs"
}
dir.create(out_dir, showWarnings = FALSE, recursive = TRUE)

df <- read.csv(in_file, stringsAsFactors = FALSE)
df$collection_date <- as.Date(df$collection_date)

flags <- validate_records(df)

# Full per-record flags (use this to test an app's validator against R)
write.csv(flags, file.path(out_dir, "validation_flags_all.csv"), row.names = FALSE)
write.csv(flags[flags$any_flag, ], file.path(out_dir, "flagged_records.csv"), row.names = FALSE)

# Summary: how many records each rule flags (rules can overlap)
summary_tbl <- data.frame(rule = RULES, records_flagged = colSums(flags[, RULES]))
summary_tbl <- rbind(summary_tbl, data.frame(rule = "ANY RULE (unique records)",
                                             records_flagged = sum(flags$any_flag)))
write.csv(summary_tbl, file.path(out_dir, "validation_summary.csv"), row.names = FALSE)
print(summary_tbl, row.names = FALSE)

# Cleaning decision: drop every flagged record (simple, conservative).
clean <- df[!flags$any_flag, ]
write.csv(clean, file.path(out_dir, "cleaned_data.csv"), row.names = FALSE)
cat("\nRaw rows:", nrow(df), " | flagged:", sum(flags$any_flag),
    " | clean rows:", nrow(clean), "\n")
