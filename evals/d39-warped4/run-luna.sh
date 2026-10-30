#!/bin/bash
# Luna low/default forest games (Lucas, Oct 26: Luna low for all further games): round l on the four seeds, then
# round m on two of them; one attempt per game, worker $1 of 2.
w=$1;h=/home/agaminggod/Desktop/Projects/aa-d39-pearls4
export MODEL=gpt-6-luna MAXATT=1
ROUND=l bash "$h/evals/d39-warped4/run-games.sh" worker "$w"
ROUND=m SEEDS="8675309 123456789" bash "$h/evals/d39-warped4/run-games.sh" worker "$w"
