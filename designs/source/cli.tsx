#!/usr/bin/env node
import React from "react";
import { render } from "ink";
import Router from "./router.js";

const designName = process.argv[2];

if (!designName) {
	console.error("usage: design <screen-name>");
	console.error("       design hello");
	process.exit(1);
}

render(<Router name={designName} />, { exitOnCtrlC: false });
