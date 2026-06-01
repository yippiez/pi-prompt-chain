#!/usr/bin/env node
import React from "react";
import { render } from "ink";
import Router from "./router.js";

const screenName = process.argv[2];

if (!screenName) {
	console.error("usage: pchain <screen-name>");
	console.error("       pchain hello");
	process.exit(1);
}

render(<Router name={screenName} />, { exitOnCtrlC: false });
