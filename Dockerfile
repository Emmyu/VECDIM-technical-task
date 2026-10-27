# API + dashboard + analysis pipeline image. Build context is the repo root (the backend imports the shared validator package).
# R is installed from Debian's own packages (binaries, so the build is quick): r-base-core plus the three
# packages the pack's R code uses (dplyr, ggplot2, randomForest). The backend runs `Rscript` itself.
FROM node:20-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends r-base-core r-cran-dplyr r-cran-ggplot2 r-cran-randomforest \
 && rm -rf /var/lib/apt/lists/* \
 && Rscript -e 'suppressPackageStartupMessages({library(dplyr); library(ggplot2); library(randomForest)}); cat(R.version.string, "\n")'
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/validator/package.json packages/validator/package.json
COPY packages/sync-core/package.json packages/sync-core/package.json
COPY backend/package.json backend/package.json
RUN npm ci --no-audit --no-fund
COPY packages packages
COPY backend backend
COPY dashboard dashboard
COPY analytics analytics
COPY seed seed
WORKDIR /app/backend
ENV NODE_ENV=production PORT=3000 ANALYTICS_DIR=/app/analytics ANALYSIS_DIR=/data/analysis
RUN mkdir -p /data/analysis
VOLUME /data/analysis
EXPOSE 3000
# Apply migrations, load the users and the dataset (safe to repeat), then start the API. The API starts the
# analysis pipeline itself: on first start, after syncs, on a timer, and on request.
CMD ["sh", "-c", "npm run migrate && npm run seed && npm start"]
