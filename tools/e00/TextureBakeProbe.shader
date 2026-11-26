Shader "Hidden/AssetFixer/TextureBakeProbe"
{
    Properties
    {
        _MainTex ("Base Color", 2D) = "white" {}
        _BumpMap ("Normal", 2D) = "bump" {}
        _Normal ("Normal enabled", Float) = 0
        _Mode ("Capture mode", Float) = 0
    }
    SubShader
    {
        Tags { "RenderType"="Opaque" }
        Pass
        {
            CGPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #pragma target 3.0
            #include "UnityCG.cginc"

            sampler2D _MainTex, _BumpMap;
            float _Normal, _Mode;

            struct Input
            {
                float4 vertex : POSITION;
                float3 normal : NORMAL;
                float4 tangent : TANGENT;
                float2 uv : TEXCOORD0;
                float3 seam : TEXCOORD2;
                float3 bary : COLOR;
            };

            struct Varying
            {
                float4 position : SV_POSITION;
                float2 uv : TEXCOORD0;
                float3 normal : TEXCOORD1;
                float4 tangent : TEXCOORD2;
                float3 seam : TEXCOORD3;
                float3 bary : TEXCOORD4;
            };

            Varying vert(Input v)
            {
                Varying o;
                o.position = UnityObjectToClipPos(v.vertex);
                o.uv = v.uv;
                o.normal = UnityObjectToWorldNormal(v.normal);
                o.tangent = float4(UnityObjectToWorldDir(v.tangent.xyz), v.tangent.w * unity_WorldTransformParams.w);
                o.seam = v.seam;
                o.bary = v.bary;
                return o;
            }

            fixed4 frag(Varying i) : SV_Target
            {
                float3 n = normalize(i.normal);
                if (_Normal > 0.5)
                {
                    float3 t = normalize(i.tangent.xyz - n * dot(n, i.tangent.xyz));
                    float3 b = cross(n, t) * i.tangent.w;
                    float3 map = UnpackNormal(tex2D(_BumpMap, i.uv));
                    n = normalize(t * map.x + b * map.y + n * map.z);
                }
                float3 albedo = tex2D(_MainTex, i.uv).rgb;
                float3 band = step(i.bary, fwidth(i.bary) * 2.0) * i.seam;
                float alpha = max(band.x, max(band.y, band.z)) > 0.5 ? 1.0 : 0.5;
                if (_Mode > 1.5) return fixed4(n * 0.5 + 0.5, alpha);
                if (_Mode > 0.5) return fixed4(albedo, alpha);
                float light = 0.31 + 0.55 * saturate(dot(n, normalize(float3(0.4, 1, -0.65))))
                    + 0.14 * saturate(dot(n, normalize(float3(-1, 0.35, 0.8))));
                return fixed4(albedo * light, alpha);
            }
            ENDCG
        }
    }
}
