# =====================================================================
# Step 3: random-forest risk model, spatial validation, early-warning alerts
# Target: high_risk (slide positivity >= 30%).
# NOTE: slide_positivity_pct defines the target, so it is NOT a predictor (leakage).
# =====================================================================
suppressPackageStartupMessages({ library(dplyr); library(randomForest); library(ggplot2) })
source("R/helpers.R")
if (!exists("in_file")) {
  a <- commandArgs(trailingOnly = TRUE)
  out_dir <- if (length(a) >= 2) a[2] else "outputs"
}
set.seed(42)

d <- read.csv(file.path(out_dir, "cleaned_data.csv"), stringsAsFactors = FALSE)
d$collection_date <- as.Date(d$collection_date)
d$month   <- as.integer(format(d$collection_date, "%m"))
d$state   <- factor(d$state)
d$species <- factor(d$species)

base_x <- c("rainfall_mm", "temp_c", "ndvi", "elevation_m", "dist_water_km", "urban",
            "itn_use_pct", "irs_covered", "larval_density", "mortality_pct",
            "month", "state", "species")

# ---- 5-fold cross-validation: random folds vs LGA-grouped (spatial) folds ----
cv_auc <- function(x_vars, folds) {
  sapply(sort(unique(folds)), function(k) {
    tr <- d[folds != k, ]; te <- d[folds == k, ]
    m <- randomForest(x = tr[, x_vars], y = factor(tr$high_risk), ntree = 500)
    auc(te$high_risk, predict(m, te[, x_vars], type = "prob")[, "1"])
  })
}
lgas <- sort(unique(d$lga))
lga_fold <- setNames(sample(rep(1:5, length.out = length(lgas))), lgas)
spatial_folds <- lga_fold[d$lga]                       # whole LGAs stay together
random_folds  <- sample(rep(1:5, length.out = nrow(d)))

settings <- list(
  "Covariates only | random 5-fold"                = cv_auc(base_x, random_folds),
  "Covariates only | LGA-grouped (spatial) 5-fold" = cv_auc(base_x, spatial_folds),
  "Covariates + lat/lon | random 5-fold"           = cv_auc(c(base_x, "latitude", "longitude"), random_folds),
  "Covariates + lat/lon | LGA-grouped (spatial) 5-fold" = cv_auc(c(base_x, "latitude", "longitude"), spatial_folds)
)
metrics <- do.call(rbind, lapply(names(settings), function(n) {
  v <- settings[[n]]
  data.frame(setting = n, mean_auc = round(mean(v), 3), sd_auc = round(sd(v), 3),
             t(setNames(round(v, 3), paste0("fold", seq_along(v)))), check.names = FALSE)
}))
write.csv(metrics, file.path(out_dir, "model_metrics.csv"), row.names = FALSE)
print(metrics[, 1:3], row.names = FALSE)

# ---- Final model (covariates only; coordinates are not used) ----
final <- randomForest(x = d[, base_x], y = factor(d$high_risk), ntree = 500, importance = TRUE)
imp <- as.data.frame(importance(final)); imp$variable <- rownames(imp)
imp <- imp[order(-imp$MeanDecreaseGini), c("variable", "MeanDecreaseGini")]
write.csv(imp, file.path(out_dir, "rf_variable_importance.csv"), row.names = FALSE)
ggsave(file.path(out_dir, "fig_variable_importance.png"),
       ggplot(imp, aes(reorder(variable, MeanDecreaseGini), MeanDecreaseGini)) +
         geom_col(fill = "#1F3864") + coord_flip() + theme_minimal() +
         labs(title = "Random forest variable importance", x = NULL),
       width = 6, height = 4.5, dpi = 150)

# ---- Out-of-bag (out-of-sample) risk probability per record ----
d$p_high <- final$votes[, "1"]
d$tier <- case_when(d$p_high >= 0.70 ~ "ALERT", d$p_high >= 0.50 ~ "WARNING", TRUE ~ "WATCH")
write.csv(d[, c("record_id", "state", "lga", "ward", "latitude", "longitude",
                "collection_date", "p_high", "tier")] %>% mutate(p_high = round(p_high, 3)),
          file.path(out_dir, "risk_predictions.csv"), row.names = FALSE)

# ---- Early-warning table: LGA x month ----
# Tiers come from predicted risk. Pyrethroid resistance is a SEPARATE flag
# (it is near-universal here; escalating on it would cause alert fatigue).
d$ym <- format(d$collection_date, "%Y-%m")
alerts <- d %>% group_by(state, lga, ym) %>%
  summarise(n = n(), mean_p_high = round(mean(p_high), 3),
            mean_pyrethroid_mort = round(mean(mortality_pct[insecticide != "Pirimiphos-methyl"]), 1),
            .groups = "drop") %>%
  mutate(alert = case_when(mean_p_high >= 0.70 ~ "ALERT",
                           mean_p_high >= 0.50 ~ "WARNING", TRUE ~ "WATCH"),
         pyrethroid_resistance_flag = !is.na(mean_pyrethroid_mort) & mean_pyrethroid_mort < 90)
write.csv(alerts, file.path(out_dir, "alerts.csv"), row.names = FALSE)
cat("\nAlert tiers (share of", nrow(alerts), "LGA-months):\n")
print(round(prop.table(table(alerts$alert)), 3))
