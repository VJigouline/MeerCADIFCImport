import { describe, expect, it } from 'vitest';
import { DERIVED, decodeStepString, StepEnum, StepFile, StepRef, StepSyntaxError, StepTyped, stepText } from '../src/step/step.js';
import { detectSchema, UnsupportedSchemaError } from '../src/ifc/schema.js';

const file = (data: string, schema = "'IFC4'") => `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [ReferenceView]'),'2;1');
FILE_NAME('a; tricky \\X2\\00E9\\X0\\.ifc','2026-01-01',('Ann','Bob'),('Org'),'pre','sys','auth');
FILE_SCHEMA((${schema}));
ENDSEC;
DATA;
${data}
ENDSEC;
END-ISO-10303-21;
`;

describe('STEP reader', () => {
  it('reads the header', () => {
    const f = new StepFile(file(''));
    expect(f.header.schemas).toEqual(['IFC4']);
    expect(f.header.fileName).toBe('a; tricky é.ifc');
    expect(f.header.author).toEqual(['Ann', 'Bob']);
    expect(f.header.description).toEqual(['ViewDefinition [ReferenceView]']);
    expect(f.header.originatingSystem).toBe('sys');
  });

  it('parses every kind of value', () => {
    const f = new StepFile(file(`#1=IFCTHING('it''s',$,*,.T.,.MILLI.,-1.5E-3,42,#7,(1,(2,3)),IFCLABEL('x'),(),"0FF");`));
    const e = f.get(1)!;
    expect(e.type).toBe('IFCTHING');
    expect(e.args[0]).toBe("it's");
    expect(e.args[1]).toBeNull();
    expect(e.args[2]).toBe(DERIVED);
    expect(e.args[3]).toEqual(new StepEnum('T'));
    expect(e.args[4]).toEqual(new StepEnum('MILLI'));
    expect(e.args[5]).toBe(-0.0015);
    expect(e.args[6]).toBe(42);
    expect(e.args[7]).toEqual(new StepRef(7));
    expect(e.args[8]).toEqual([1, [2, 3]]);
    expect(e.args[9]).toEqual(new StepTyped('IFCLABEL', 'x'));
    expect(e.args[10]).toEqual([]);
    expect(e.args[11]).toBe('0FF');
  });

  it('skips comments, and strings that look like entities, and reads entities over several lines', () => {
    const f = new StepFile(file(`/* #9=IFCFAKE(); */
#1=IFCA('#2=IFCFAKE(;)');
#2 = IFCB(
  1,
  /* inline */ 2);
#3=IFCA((#1,#2));`));
    expect([...f.ids].sort()).toEqual([1, 2, 3]);
    expect(f.get(2)!.args).toEqual([1, 2]);
    expect(f.idsOfType('IfcA')).toEqual([1, 3]);
    expect(f.typeOf(2)).toBe('IFCB');
    expect(f.get(9)).toBeUndefined();
  });

  it("reads complex instances as their parts' attributes in order", () => {
    const f = new StepFile(file(`#1=(IFCA(1)IFCB(2,'x'));`));
    expect(f.get(1)!.args).toEqual([1, 2, 'x']);
  });

  it('decodes ISO 10303-21 string escapes', () => {
    expect(decodeStepString("O''Neil")).toBe("O'Neil");
    expect(decodeStepString('\\X2\\00E900E8\\X0\\')).toBe('éè');
    expect(decodeStepString('\\X4\\0001F600\\X0\\')).toBe('😀');
    expect(decodeStepString('\\X\\E9t\\X\\E9')).toBe('été');
    expect(decodeStepString('\\S\\i')).toBe('é');
    expect(decodeStepString('a\\\\b')).toBe('a\\b');
  });

  it('rejects text that is not STEP, and reports malformed data where it is read', () => {
    expect(() => new StepFile('hello')).toThrow(StepSyntaxError);
    const f = new StepFile(file(`#1=IFCA(1,,2);`));
    expect(() => f.get(1)).toThrow(StepSyntaxError);
  });

  it('decodes UTF-8 bytes', () => {
    expect(stepText(new TextEncoder().encode('é'))).toBe('é');
  });
});

describe('schema detection', () => {
  it('recognises IFC2X3 and every schema of the IFC4 line', () => {
    const cases: [string, string, string][] = [
      ['IFC2X3', 'IFC2X3', 'IFC2X3'], ['IFC2X3_TC1', 'IFC2X3', 'IFC2X3'],
      ['IFC2X4', 'IFC4', 'IFC4'], ['IFC2X4_RC2', 'IFC4', 'IFC4'],
      ['IFC4', 'IFC4', 'IFC4'], ['IFC4_ADD1', 'IFC4', 'IFC4'], ['IFC4_ADD2', 'IFC4', 'IFC4'], ['IFC4_ADD2_TC1', 'IFC4', 'IFC4'],
      ['IFC4X1', 'IFC4X1', 'IFC4'], ['IFC4X2', 'IFC4X2', 'IFC4'],
      ['IFC4X3', 'IFC4X3', 'IFC4'], ['IFC4X3_ADD1', 'IFC4X3', 'IFC4'], ['IFC4X3_ADD2', 'IFC4X3', 'IFC4'], ['IFC4X3_TC1', 'IFC4X3', 'IFC4'],
      ['ifc4', 'IFC4', 'IFC4'],
    ];
    for (const [identifier, id, family] of cases) {
      const info = detectSchema([identifier]);
      expect([identifier, info.id, info.family, info.guessed]).toEqual([identifier, id, family, false]);
    }
  });

  it('reads unknown addenda by their prefix, saying so', () => {
    const info = detectSchema(['IFC4X3_ADD9']);
    expect(info.id).toBe('IFC4X3');
    expect(info.guessed).toBe(true);
    expect(detectSchema(['IFC4_ADD7']).id).toBe('IFC4');
  });

  it('refuses other schemas', () => {
    expect(() => detectSchema(['IFC2X2_FINAL'])).toThrow(UnsupportedSchemaError);
    expect(() => detectSchema(['AP214'])).toThrow(UnsupportedSchemaError);
    expect(() => detectSchema([])).toThrow(UnsupportedSchemaError);
  });
});
