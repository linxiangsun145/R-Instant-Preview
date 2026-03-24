import { strict as assert } from "node:assert";
import { buildSmartContextCodeFromText } from "../util/smartContext";

function normalize(text: string): string {
  return text.trim().replace(/\r\n/g, "\n");
}

function runTests(): void {
  {
    const code = [
      "noise <- 999",
      "x <- 1:5",
      "y <- x * 2",
      "z <- y + 10",
      "mean(z)"
    ].join("\n");

    const out = buildSmartContextCodeFromText(code, 4, "mean(z)");
    const expected = [
      "x <- 1:5",
      "y <- x * 2",
      "z <- y + 10",
      "mean(z)"
    ].join("\n");

    assert.equal(normalize(out), normalize(expected), "should include minimal recursive dependency chain");
  }

  {
    const code = [
      "x <- 1",
      "y <- 2",
      "print(123)"
    ].join("\n");

    const out = buildSmartContextCodeFromText(code, 2, "print(123)");
    assert.equal(normalize(out), "print(123)", "should keep selection only when no upstream dependency exists");
  }

  {
    const code = [
      "x <- 1",
      "x <- 2",
      "y <- x + 1",
      "y"
    ].join("\n");

    const out = buildSmartContextCodeFromText(code, 3, "y");
    const expected = [
      "x <- 2",
      "y <- x + 1",
      "y"
    ].join("\n");

    assert.equal(normalize(out), normalize(expected), "should use the closest previous assignment for each symbol");
  }

  {
    const code = [
      "a <- 1 # comment here",
      "b <- a + 2",
      "b"
    ].join("\n");

    const out = buildSmartContextCodeFromText(code, 2, "b");
    const expected = [
      "a <- 1 # comment here",
      "b <- a + 2",
      "b"
    ].join("\n");

    assert.equal(normalize(out), normalize(expected), "should parse dependencies correctly with trailing comments");
  }

  {
    const code = [
      "x[1] <- 10",
      "y <- x[1] + 3",
      "y"
    ].join("\n");

    const out = buildSmartContextCodeFromText(code, 2, "y");
    const expected = [
      "x[1] <- 10",
      "y <- x[1] + 3",
      "y"
    ].join("\n");

    assert.equal(normalize(out), normalize(expected), "should support indexed assignment target like x[1] <- ...");
  }

  {
    const code = [
      "df$col <- 7",
      "z <- df$col + 1",
      "z"
    ].join("\n");

    const out = buildSmartContextCodeFromText(code, 2, "z");
    const expected = [
      "df$col <- 7",
      "z <- df$col + 1",
      "z"
    ].join("\n");

    assert.equal(normalize(out), normalize(expected), "should support member assignment target like df$col <- ...");
  }

  {
    const code = [
      "x <- (",
      "  1 +",
      "  2",
      ")",
      "y <- x + 1",
      "y"
    ].join("\n");

    const out = buildSmartContextCodeFromText(code, 5, "y");
    const expected = [
      "x <- (",
      "  1 +",
      "  2",
      ")",
      "y <- x + 1",
      "y"
    ].join("\n");

    assert.equal(normalize(out), normalize(expected), "should include multiline assignment block when needed");
  }

  {
    const code = [
      "x <- c(30, 10, 20)",
      "labels <- c(\"A\", \"B\", \"C\")",
      "cols <- c(\"red\", \"green\", \"blue\")",
      "pie(x)",
      "legend(\"topright\", legend = labels, fill = cols)"
    ].join("\n");

    const out = buildSmartContextCodeFromText(code, 4, "legend(\"topright\", legend = labels, fill = cols)");
    const expected = [
      "x <- c(30, 10, 20)",
      "labels <- c(\"A\", \"B\", \"C\")",
      "cols <- c(\"red\", \"green\", \"blue\")",
      "pie(x)",
      "legend(\"topright\", legend = labels, fill = cols)"
    ].join("\n");

    assert.equal(normalize(out), normalize(expected), "should include legend dependencies and nearest prior plot producer with its deps");
  }

  console.log("smartContext tests passed");
}

runTests();
