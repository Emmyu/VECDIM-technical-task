# Runs the whole R pipeline. From the pack's root folder:
#   Rscript R/run_all.R data/vecdim_dummy_entomology_data.csv outputs
# Needs R >= 4.0 and packages: dplyr, ggplot2, randomForest
a <- commandArgs(trailingOnly = TRUE)
in_file <- if (length(a) >= 1) a[1] else "data/vecdim_dummy_entomology_data.csv"
out_dir <- if (length(a) >= 2) a[2] else "outputs"
source("R/01_validate_and_clean.R")
source("R/02_descriptive_analysis.R")
source("R/03_rf_model_and_alerts.R")
cat("\nPipeline complete. Outputs in:", normalizePath(out_dir), "\n")
