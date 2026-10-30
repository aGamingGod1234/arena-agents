#!/bin/bash
set -u
b=/home/agaminggod/Desktop/Projects/arena-beat-game
h=/home/agaminggod/Desktop/Projects/aa-d39-pearls4
a=$b/evals/d39-warped4
mkdir -p "$a"
cd "$h"
export JAVA_HOME=/usr/lib/jvm/temurin-25-jdk-amd64
case "$1" in
 build) "$b/slot.sh" gradle ./gradlew build verifyCore --offline > "$a/gradle.log" 2>&1; echo $? > "$a/gradle.exit";;
 coordinator) cd coordinator; "$b/slot.sh" eval npm test > "$a/npm-test.log" 2>&1; echo $? > "$a/npm-test.exit"; "$b/slot.sh" eval npm run test:contracts > "$a/contracts.log" 2>&1; echo $? > "$a/contracts.exit";;
esac
