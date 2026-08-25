#!/usr/bin/env bun

import { runCliWithHandlers } from "./app";
import { main } from "./ui";

await runCliWithHandlers(main);
