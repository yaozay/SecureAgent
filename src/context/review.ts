import { PRFile, PatchInfo } from "../constants";
import * as parser from '@babel/parser';
import traverse from "@babel/traverse";
import { applyPatch, parsePatch } from "diff"
import * as diff from 'diff';

const expandHunk = (contents: string, hunk: diff.Hunk, linesAbove: number = 5, linesBelow: number = 5) => {
    const fileLines = contents.split("\n");
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
    return curExpansion.join("\n");
}

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

const numberLines = (lines: string[], startLine: number) => {
    const numbered = lines.map((line, idx) => {
        return {lineNumber: startLine + idx, line: line}
    })
    return numbered;
}

const injectionPoint = (hunk: diff.Hunk) => {
    const idx = hunk.lines.findIndex(line => line.startsWith('+') || line.startsWith('-'));
    return hunk.newStart + idx;
}

const functionalContextPerHunk = (currentFile: string, hunk: diff.Hunk) => {
    // const patches = getChangedLinesFromPatch(parsePatch(patch));
    const res: string[] = [];
    const ast = parser.parse(currentFile, {
        sourceType: 'module',
        plugins: ['jsx', 'typescript'], // To allow JSX and TypeScript
    });
    let largestEnclosingFunction: any = null;
    let largestSize = 0;
    const insertions = hunk.lines.filter((line) => line.startsWith("+")).length;
    const lineStart = hunk.newStart;
    const lineEnd = lineStart + insertions;
    traverse(ast, {
        Function(path) {
            const { start, end } = path.node.loc;
            if (start.line <= lineStart && lineEnd <= end.line) {
                const size = end.line - start.line;
                if (size > largestSize) {
                    largestSize = size;
                    largestEnclosingFunction = path.node;
                }
            }
        },
    });
    if (largestEnclosingFunction) {
        const functionStartLine = largestEnclosingFunction.loc.start.line;
        const functionEndLine = largestEnclosingFunction.loc.end.line;
        const updatedFileLines = currentFile.split('\n');
        const functionContext = updatedFileLines.slice(functionStartLine - 1, functionEndLine);
        const injectionIdx = injectionPoint(hunk);
        const numberedFunctionLines = numberLines(functionContext, functionStartLine - 1);
        const editLines = hunk.lines.filter(line => line.startsWith("-") || line.startsWith("+"));
        const holder: string[] = [];
        const hunkHeader = `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`;
        holder.push(hunkHeader);
        numberedFunctionLines.forEach((numberedLine) => {
            if (numberedLine.lineNumber == injectionIdx+1) {
                holder.push(...editLines);
            }
            holder.push(numberedLine.line);
        });
        const injected = holder.join("\n");
        res.push(injected);
        return res;
    } else {
        throw new Error("An enclosing function could not be found.");
    }
}

const diffContextPerHunk = (file: PRFile) => {
    const updatedFile = diff.applyPatch(file.old_contents, file.patch);
    const patches = diff.parsePatch(file.patch);
    if (!updatedFile) {
        console.log("APPLYING PATCH ERROR - FALLINGBACK");
        // return fallback
        throw "THIS SHOULD NOT HAPPEN!"
    }
    if (typeof updatedFile === 'string') {
        const hunks: diff.Hunk[] = [];
        patches.forEach((p) => {
            p.hunks.forEach((hunk) => {
                hunks.push(hunk);
            })
        });
        const contextPerHunk: string[] = [];
        hunks.forEach(hunk => {
            let context: string = null;
            try {
                // should only for ts, tsx, js, jsx files rn
                context = functionalContextPerHunk(updatedFile, hunk).join("\n")
                console.log("!!!!!!!!!! WORKED !!!!!!!!!!!!!!")
                console.log(context);
            } catch (exc) {
                console.log("!!!!!!!! FALLING BACK !!!!!!!!!")
                context = expandHunk(file.old_contents, hunk);
            }
            contextPerHunk.push(context);
        })
        return contextPerHunk;
    } else {
        throw new Error("This should never be thrown")
    }
}

const functionContextPatchStrategy = (file: PRFile) => {
    console.log("USING DIFF FUNCTION CONTEXT STRATEGY");
    const contextChunks = diffContextPerHunk(file);
    let res = null;
    try {
        res = `## ${file.filename}\n\n${contextChunks.join("\n\n")}`;
    } catch (exc) {
        res = expandedPatchStrategy(file);
    }
    return res;
}

export const smarterContextPatchStrategy = (file: PRFile) => {
    const fileExtension = file.filename.split('.').pop().toLowerCase();
    const extensionsSupportingFunctionalContext = ['ts', 'tsx', 'js', 'jsx'];
    if (extensionsSupportingFunctionalContext.includes(fileExtension)) {
        return functionContextPatchStrategy(file);
    } else {
        return expandedPatchStrategy(file);
    }
}