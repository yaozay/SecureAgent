import { AbstractParser, EnclosingContext } from "../../constants";
import * as parser from '@babel/parser';
import traverse from "@babel/traverse";

export class JavascriptParser implements AbstractParser {
    findEnclosingFunction(file: string, lineStart: number, lineEnd: number): EnclosingContext {
        const ast = parser.parse(file, {
            sourceType: 'module',
            plugins: ['jsx', 'typescript'], // To allow JSX and TypeScript
        });
        let largestEnclosingFunction: any = null;
        let largestSize = 0;
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
            TSInterfaceDeclaration(path) {
                console.log("IN INTERFACE PROCESS")
                const { start, end } = path.node.loc;
                if (start.line <= lineStart && lineEnd <= end.line) {
                    const size = end.line - start.line;
                    if (size > largestSize) {
                        largestSize = size;
                        largestEnclosingFunction = path.node;
                    }
                }
            }
        });
        return {
            enclosingFunction: largestEnclosingFunction
        } as EnclosingContext;
    }
}

