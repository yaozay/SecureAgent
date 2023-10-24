import { PRFile, PatchInfo } from "../constants";
import * as diff from 'diff';
import * as parser from '@babel/parser';
import traverse from "@babel/traverse";

const expandFileLines = (file: PRFile, linesAbove: number = 5, linesBelow: number = 5) => {
    const fileLines = file.old_contents.split("\n");
    const patches: PatchInfo[] = diff.parsePatch(file.patch);
    const expandedLines: string[][] = [];
    patches.forEach(patch => {
      patch.hunks.forEach(hunk => {
        const curExpansion: string[] = [];
        const start = Math.max(0, hunk.oldStart - 1 - linesAbove);
        const end = Math.min(fileLines.length, hunk.oldStart - 1 + hunk.oldLines + linesBelow);
  
        for (let i = start; i < hunk.oldStart - 1; i++) {
            curExpansion.push(fileLines[i]);
        }
  
        curExpansion.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);
        hunk.lines.forEach(line => {
            if (!curExpansion.includes(line)) {
              curExpansion.push(line);
            }
          });
  
        for (let i = hunk.oldStart - 1 + hunk.oldLines; i < end; i++) {
            curExpansion.push(fileLines[i]);
        }
        expandedLines.push(curExpansion);
      });
    });
  
    return expandedLines;
};
  

export const expandedPatchStrategy = (file: PRFile) => {
    const expandedPatches = expandFileLines(file);
    const expansions = expandedPatches.map((patchLines) => patchLines.join("\n")).join("\n\n")
    return `## ${file.filename}\n\n${expansions}`;
}
  
export const rawPatchStrategy = (file: PRFile) => {
    return `## ${file.filename}\n\n${file.patch}`;
}
  
const escapeString = (str: string) => JSON.parse(JSON.stringify(str));

const findEnclosingFunction = (file: string, lineNumber: number) => {
    const code: string = escapeString(file);
    
    const ast = parser.parse(code, { 
    sourceType: "module",
    plugins: ["jsx", "typescript"] // To allow JSX and TypeScript
    });

    let functionStack: Array<{ context: { startLine: number, endLine: number }, name: string }> = [];

    traverse(ast, {
    enter(path) {
        if (path.isFunction()) {
        const { start, end } = path.node.loc;
        //   console.log(`${JSON.stringify(start)}, ${JSON.stringify(end)}`)
        if (start && end && start.line <= lineNumber && lineNumber <= end.line) {
            console.log("!!!")
            let functionName = "anonymous function";
            if (path.node.type === "ArrowFunctionExpression" && path.parent.type === "VariableDeclarator") {
                if (path.parent.id.type === "Identifier") {
                    functionName = path.parent.id.name;
                }
            } else if (path.node.type === "FunctionDeclaration" || path.node.type === "FunctionExpression") {
            functionName = path.node.id?.name || "anonymous function";
            }
            functionStack.push({
            context: { 
                startLine: start.line,
                endLine: end.line 
            },
            name: functionName
            });
        }
        }
    },
    });
    return functionStack.reverse();
};

export const functionContextPatchStrategy = (file: PRFile) => {
    const patches: PatchInfo[] = diff.parsePatch(file.patch);
    console.log(JSON.stringify(patches));
    throw "Unimplemented"
}