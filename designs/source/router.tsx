/**
 * router.tsx — maps design names to screen components.
 *
 * The router wraps every screen in a consistent full-screen layout
 * that handles exit keys (q, esc, ctrl+c) and terminal resize.
 */

import React, { useEffect, useState, type ComponentType } from "react";
import { Box, Text, useInput, useStdout } from "ink";
import HelloScreen from "./screens/hello.js";

/** All registered screens. Add new ones here. */
const SCREENS: Record<string, ComponentType> = {
	hello: HelloScreen,
};

interface RouterProps {
	/** Design name passed on the CLI. */
	name: string;
}

export default function Router({ name }: RouterProps) {
	const { stdout } = useStdout();
	const [rows, setRows] = useState(stdout.rows);

	useEffect(() => {
		const onResize = () => setRows(stdout.rows);
		stdout.on("resize", onResize);
		return () => { stdout.off("resize", onResize); };
	}, [stdout]);

	useInput((input, key) => {
		if (input === "q" || key.escape || (input === "c" && key.ctrl) || input === "d") {
			process.exit(0);
		}
	});

	const Screen = SCREENS[name];
	if (!Screen) {
		return (
			<Box flexDirection="column">
				<Box justifyContent="center" marginTop={2}>
					<Text color="red" bold>
						unknown design: {name}
					</Text>
				</Box>
				<Box justifyContent="center" marginTop={1}>
					<Text dimColor>available: {Object.keys(SCREENS).join(", ")}</Text>
				</Box>
				<Box justifyContent="center" marginTop={1}>
					<Text dimColor>press q or esc to exit</Text>
				</Box>
			</Box>
		);
	}

	return <Screen />;
}
