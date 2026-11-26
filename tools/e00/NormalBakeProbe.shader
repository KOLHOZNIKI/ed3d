Shader "Hidden/AssetFixer/NormalBakeProbe"
{
    Properties
    {
        _BumpMap ("Normal", 2D) = "bump" {}
        _OldUv ("Sample original UVs", Float) = 0
        _Lighting ("Output light response", Float) = 0
    }
    SubShader
    {
        Pass
        {
            CGPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #pragma target 3.0
            #include "UnityCG.cginc"

            sampler2D _BumpMap;
            float _OldUv, _Lighting;
            float4 _LightA, _LightB;

            struct Input
            {
                float4 vertex : POSITION;
                float3 normal : NORMAL;
                float4 tangent : TANGENT;
                float2 uv : TEXCOORD0;
                float2 uv1 : TEXCOORD1;
            };

            struct Varying
            {
                float4 position : SV_POSITION;
                float2 uv : TEXCOORD0;
                float3 normal : TEXCOORD1;
                float4 tangent : TEXCOORD2;
                float panel : TEXCOORD3;
            };

            Varying vert(Input v)
            {
                Varying o;
                o.position = UnityObjectToClipPos(v.vertex);
                o.uv = _OldUv > 0.5 ? v.uv1 : v.uv;
                o.normal = UnityObjectToWorldNormal(v.normal);
                o.tangent = float4(UnityObjectToWorldDir(v.tangent.xyz), v.tangent.w * unity_WorldTransformParams.w);
                o.panel = abs(v.normal.z) > 0.8 ? 0.5 : 1.0;
                return o;
            }

            float4 frag(Varying i) : SV_Target
            {
                float3 n = normalize(i.normal);
                float3 t = normalize(i.tangent.xyz - dot(i.tangent.xyz, n) * n);
                float3 b = cross(n, t) * i.tangent.w;
                float3 map = UnpackNormal(tex2D(_BumpMap, i.uv));
                float3 world = normalize(t * map.x + b * map.y + n * map.z);
                if (_Lighting > 0.5)
                    return float4(saturate(dot(world, _LightA.xyz)), saturate(dot(world, _LightB.xyz)), 0, i.panel);
                return float4(world * 0.5 + 0.5, i.panel);
            }
            ENDCG
        }
    }
}
