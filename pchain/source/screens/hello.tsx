/**
 * Default screen — hello world centered in terminal.
 */
import React, { useEffect, useState } from "react";
import { Box, Text, useStdout } from "ink";

export default function HelloScreen() {
	const { stdout } = useStdout();
	const [rows, setRows] = useState(stdout.rows);

	useEffect(() => {
		const onResize = () => setRows(stdout.rows);
		stdout.on("resize", onResize);
		return () => { stdout.off("resize", onResize); };
	}, [stdout]);

	const topPad = Math.max(0, Math.floor((rows - 3) / 2));

	return (
		<Box flexDirection="column">
			{Array.from({ length: topPad }).map((_, i) => (
				<Text key={i}>{"\n"}</Text>
			))}
			<Box justifyContent="center">
				<Text color="green" bold>
					hello world
				</Text>
			</Box>
			<Box justifyContent="center" marginTop={1}>
				<Text dimColor>press q or esc to exit</Text>
			</Box>
		</Box>
	);
}
