#!/bin/bash
for idx in messages entities preferences facts traces; do
  wrangler vectorize create "cf-mem-${idx}" --dimensions=768 --metric=cosine
done
