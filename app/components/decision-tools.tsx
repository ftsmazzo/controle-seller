'use client';
import { useMemo, useState } from 'react';

export function PriceSimulator() {
  const [cost,setCost]=useState(0);
  const [fixed,setFixed]=useState(0);
  const [rates,setRates]=useState(20);
  const [margin,setMargin]=useState(20);
  const price=useMemo(()=>{
    const denominator=1-(rates+margin)/100;
    return denominator>0?Math.ceil((cost+fixed)/denominator):null;
  },[cost,fixed,rates,margin]);
  return <div className="simulator">
    <h3>Simulador de preço</h3><p className="muted">Cenário local; não altera catálogo.</p>
    <label>Custo (centavos)<input type="number" min="0" value={cost} onChange={e=>setCost(Number(e.target.value))}/></label>
    <label>Frete + embalagem<input type="number" min="0" value={fixed} onChange={e=>setFixed(Number(e.target.value))}/></label>
    <label>Taxas + impostos (%)<input type="number" min="0" max="99" value={rates} onChange={e=>setRates(Number(e.target.value))}/></label>
    <label>Margem desejada (%)<input type="number" min="0" max="99" value={margin} onChange={e=>setMargin(Number(e.target.value))}/></label>
    <output className="sim-result" aria-live="polite"><span>Preço mínimo</span><strong>{price==null?'Parâmetros inválidos':new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format(price/100)}</strong></output>
  </div>;
}
